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
  let configStub;
  let postgrestStub;
  let tableRows;

  const TARGET_SITE_ID = '11111111-2222-3333-4444-555555555555';
  const OTHER_SITE_ID = '22222222-3333-4444-5555-555555555555';
  const MISSING_SITE_ID = '33333333-4444-5555-6666-555555555555';

  const makeSite = (id, baseURL) => ({
    getId: () => id,
    getBaseURL: () => baseURL,
    getLatestAuditByAuditType: sinon.stub().resolves(null),
  });

  const makePostgrestChain = (result) => {
    const chain = {
      select: sinon.stub(),
      in: sinon.stub(),
      eq: sinon.stub(),
    };
    chain.select.returns(chain);
    chain.in.returns(chain);
    chain.eq.resolves(result);
    return chain;
  };

  const installPostgrestRows = () => {
    postgrestStub.from.callsFake((table) => makePostgrestChain({
      data: tableRows[table] || [],
      error: null,
    }));
  };

  beforeEach(() => {
    tableRows = {
      agentic_traffic: [],
      agentic_traffic_daily: [],
      agentic_traffic_weekly: [],
    };
    configStub = { isHandlerEnabledForSite: sinon.stub().returns(true) };
    postgrestStub = { from: sinon.stub() };
    installPostgrestRows();

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
    slackContext = { say: sinon.stub().resolves() };
  });

  afterEach(() => {
    sinon.restore();
  });

  it('has the correct id and phrase', () => {
    const cmd = CheckAgenticTrafficDbStatusCommand(context);

    expect(cmd.id).to.equal('check-agentic-traffic-db-status');
    expect(cmd.accepts('check agentic traffic db status')).to.be.true;
  });

  it('warns on invalid date format', async () => {
    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-99-99'], slackContext);

    expect(slackContext.say).to.have.been.calledWith(
      ':warning: Invalid date format. Use YYYY-MM-DD.',
    );
    expect(postgrestStub.from).not.to.have.been.called;
  });

  it('warns when the requested traffic date is in the future', async () => {
    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2099-01-01'], slackContext);

    expect(slackContext.say).to.have.been.calledWith(
      ':warning: Cannot check a future traffic date.',
    );
    expect(postgrestStub.from).not.to.have.been.called;
  });

  it('warns when siteId is invalid', async () => {
    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['siteId=foo'], slackContext);

    expect(slackContext.say).to.have.been.calledWith(
      ':warning: Invalid siteId. Expected UUID.',
    );
    expect(context.dataAccess.Site.findById).not.to.have.been.called;
  });

  it('warns when PostgREST is unavailable', async () => {
    context.dataAccess.services = {};

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    expect(slackContext.say).to.have.been.calledWith(
      ':warning: PostgREST client is unavailable; cannot check agentic traffic tables.',
    );
  });

  it('uses yesterday as the default traffic date', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-04-23T12:00:00Z').getTime());

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution([], slackContext);
    clock.restore();

    expect(slackContext.say.firstCall.args[0]).to.include(
      'Checking agentic traffic DB tables for *2026-04-22*',
    );
  });

  it('reports when the requested siteId is not found', async () => {
    context.dataAccess.Site.findById.resolves(null);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22', `siteId=${MISSING_SITE_ID}`], slackContext);

    expect(slackContext.say).to.have.been.calledWith(
      `:warning: No site found with siteId \`${MISSING_SITE_ID}\`.`,
    );
    expect(context.dataAccess.Site.all).not.to.have.been.called;
  });

  it('reports when no sites have cdn-logs-report enabled', async () => {
    configStub.isHandlerEnabledForSite.returns(false);
    context.dataAccess.Site.all.resolves([
      makeSite(TARGET_SITE_ID, 'https://example.com'),
    ]);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    expect(slackContext.say).to.have.been.calledWith(
      ':information_source: No sites have cdn-logs-report enabled.',
    );
    expect(postgrestStub.from).not.to.have.been.called;
  });

  it('reports when the requested site does not have cdn-logs-report enabled', async () => {
    configStub.isHandlerEnabledForSite.returns(false);
    context.dataAccess.Site.findById.resolves(
      makeSite(TARGET_SITE_ID, 'https://disabled.example.com'),
    );

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22', `siteId=${TARGET_SITE_ID}`], slackContext);

    expect(slackContext.say).to.have.been.calledWith(
      `:information_source: Site \`${TARGET_SITE_ID}\` does not have cdn-logs-report enabled.`,
    );
    expect(postgrestStub.from).not.to.have.been.called;
  });

  it('checks raw, daily, and weekly tables directly for one site', async () => {
    const targetSite = makeSite(TARGET_SITE_ID, 'https://wknd.site');
    context.dataAccess.Site.findById.resolves(targetSite);
    tableRows.agentic_traffic = [
      { site_id: TARGET_SITE_ID, hits: 20, updated_at: '2026-05-04T10:07:12Z' },
      { site_id: TARGET_SITE_ID, hits: 34, updated_at: '2026-05-04T10:07:13Z' },
    ];
    tableRows.agentic_traffic_daily = [
      { site_id: TARGET_SITE_ID, hits: 54, updated_at: '2026-05-04T10:07:14Z' },
    ];
    tableRows.agentic_traffic_weekly = [
      { site_id: TARGET_SITE_ID, hits: 500, updated_at: '2026-05-04T10:08:00Z' },
    ];

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-05-03', `siteId=${TARGET_SITE_ID}`], slackContext);

    expect(targetSite.getLatestAuditByAuditType).not.to.have.been.called;
    expect(postgrestStub.from.args.map(([table]) => table)).to.deep.equal([
      'agentic_traffic',
      'agentic_traffic_daily',
      'agentic_traffic_weekly',
    ]);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Agentic Traffic DB Table Status — 2026-05-03');
    expect(output).to.include('Outcome: *DASHBOARD_READY*');
    expect(output).to.include('Raw table: *1/1* sites, 2 rows / 54 hits');
    expect(output).to.include('Daily table: *1/1* sites, 1 rows / 54 hits');
    expect(output).to.include('Weekly table (2026-04-27): *1/1* sites, 1 rows / 500 hits');
    expect(output).to.include('https://wknd.site');
  });

  it('caps long site detail lists and points to focused site checks', async () => {
    const sites = Array.from({ length: 9 }, (_, index) => {
      const siteId = `11111111-2222-3333-4444-${String(index + 1).padStart(12, '0')}`;
      return makeSite(siteId, `https://site-${index + 1}.example.com`);
    });
    context.dataAccess.Site.all.resolves(sites);
    tableRows.agentic_traffic = sites.map((site) => ({
      site_id: site.getId(),
      hits: 10,
      updated_at: '2026-04-22T08:00:00Z',
    }));
    tableRows.agentic_traffic_daily = sites.map((site) => ({
      site_id: site.getId(),
      hits: 10,
      updated_at: '2026-04-22T08:01:00Z',
    }));

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Dashboard-ready: *9*');
    expect(output).to.include('... 1 more. Re-run with `siteId=<siteId>` for focused details.');
  });

  it('ignores malformed table rows and prints invalid timestamps as-is', async () => {
    context.dataAccess.Site.all.resolves([
      makeSite(TARGET_SITE_ID, 'https://defensive.com'),
    ]);
    tableRows.agentic_traffic = [
      { hits: 999, updated_at: '2026-04-22T07:59:00Z' },
      { site_id: TARGET_SITE_ID, hits: 10, updated_at: '2026-04-22T08:00:00Z' },
    ];
    tableRows.agentic_traffic_daily = [
      { site_id: TARGET_SITE_ID, hits: 10, updated_at: 'not-a-date' },
    ];

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Raw table: *1/1* sites, 1 rows / 10 hits');
    expect(output).to.include('daily: 1 rows / 10 hits (updated not-a-date)');
  });

  it('handles missing hits, non-numeric hits, and null table responses', async () => {
    context.dataAccess.Site.all.resolves([
      makeSite(TARGET_SITE_ID, 'https://odd-rows.com'),
    ]);
    postgrestStub.from.withArgs('agentic_traffic').returns(makePostgrestChain({
      data: [
        { site_id: TARGET_SITE_ID, updated_at: '2026-04-22T08:00:00Z' },
        { site_id: TARGET_SITE_ID, hits: 'not-a-number' },
      ],
      error: null,
    }));
    postgrestStub.from.withArgs('agentic_traffic_daily').returns(makePostgrestChain({
      data: null,
      error: null,
    }));
    postgrestStub.from.withArgs('agentic_traffic_weekly').returns(makePostgrestChain({
      data: [],
      error: null,
    }));

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Raw table: *1/1* sites, 2 rows / 0 hits');
    expect(output).to.include('Daily table: *0/1* sites, 0 rows / 0 hits');
  });

  it('reports missing daily rows when raw rows exist', async () => {
    context.dataAccess.Site.all.resolves([
      makeSite(TARGET_SITE_ID, 'https://raw-only.com'),
    ]);
    tableRows.agentic_traffic = [
      { site_id: TARGET_SITE_ID, hits: 10, updated_at: '2026-04-22T08:00:00Z' },
    ];

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Outcome: *ACTION_REQUIRED*');
    expect(output).to.include('Missing raw import: *0*');
    expect(output).to.include('Missing daily serving: *1*');
    expect(output).to.include('missing: daily');
    expect(output).to.include('https://raw-only.com');
  });

  it('reports no DB rows for the date when all checked tables are empty', async () => {
    context.dataAccess.Site.all.resolves([
      makeSite(TARGET_SITE_ID, 'https://empty-one.com'),
      makeSite(OTHER_SITE_ID, 'https://empty-two.com'),
    ]);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Outcome: *NO_DB_ROWS_FOR_DATE*');
    expect(output).to.include('Missing raw import: *2*');
    expect(output).to.include('Missing daily serving: *2*');
    expect(output).to.include('Raw table: *0/2* sites, 0 rows / 0 hits');
    expect(output).to.include('Daily table: *0/2* sites, 0 rows / 0 hits');
  });

  it('does not report no DB rows when only weekly rows exist for a closed Sunday', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-05-04T12:00:00Z').getTime());
    context.dataAccess.Site.all.resolves([
      makeSite(TARGET_SITE_ID, 'https://weekly-only.com'),
    ]);
    tableRows.agentic_traffic_weekly = [
      { site_id: TARGET_SITE_ID, hits: 12, updated_at: '2026-05-04T08:02:00Z' },
    ];

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-05-03'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Outcome: *ACTION_REQUIRED*');
    expect(output).to.not.include('Outcome: *NO_DB_ROWS_FOR_DATE*');
    expect(output).to.include('Weekly table (2026-04-27): *1/1* sites, 1 rows / 12 hits');
  });

  it('marks weekly as required for a closed Sunday', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-05-04T12:00:00Z').getTime());
    context.dataAccess.Site.all.resolves([
      makeSite(TARGET_SITE_ID, 'https://closed-sunday.com'),
    ]);
    tableRows.agentic_traffic = [
      { site_id: TARGET_SITE_ID, hits: 10, updated_at: '2026-05-04T08:00:00Z' },
    ];
    tableRows.agentic_traffic_daily = [
      { site_id: TARGET_SITE_ID, hits: 10, updated_at: '2026-05-04T08:01:00Z' },
    ];

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-05-03'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Missing weekly serving: *1*');
    expect(output).to.include('Weekly table (2026-04-27): *0/1* sites, 0 rows / 0 hits');
    expect(output).to.include('missing: weekly');
  });

  it('surfaces table query errors through the generic Slack error handler', async () => {
    const targetSite = makeSite(TARGET_SITE_ID, 'https://error.com');
    context.dataAccess.Site.all.resolves([targetSite]);
    postgrestStub.from.withArgs('agentic_traffic').returns(makePostgrestChain({
      data: null,
      error: { message: 'relation missing' },
    }));
    postgrestStub.from.withArgs('agentic_traffic_daily').returns(makePostgrestChain({
      data: [],
      error: null,
    }));
    postgrestStub.from.withArgs('agentic_traffic_weekly').returns(makePostgrestChain({
      data: [],
      error: null,
    }));

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    expect(context.log.error).to.have.been.calledWith(
      'Error in check-agentic-traffic-db-status:',
      sinon.match.instanceOf(Error),
    );
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('relation missing');
  });
});
