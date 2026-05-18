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
  let countsByTable;
  let rangeCountsByTable;
  let countsBySiteTable;
  let rangeCountsBySiteTable;
  let tableErrorByName;
  let rangeErrorByTable;
  let flakyByTable;

  const TARGET_SITE_ID = '11111111-2222-3333-4444-555555555555';
  const OTHER_SITE_ID = '22222222-3333-4444-5555-555555555555';
  const MISSING_SITE_ID = '33333333-4444-5555-6666-555555555555';

  const makeSite = (id, baseURL) => ({
    getId: () => id,
    getBaseURL: () => baseURL,
    getLatestAuditByAuditType: sinon.stub().resolves(null),
  });

  const installPostgrestMock = () => {
    postgrestStub.from.callsFake((table) => {
      let siteId;
      let isRange = false;
      const chain = {
        select: sinon.stub(),
        eq: sinon.stub(),
        gte: sinon.stub(),
        lte: sinon.stub(),
      };
      chain.select.returns(chain);
      chain.eq.callsFake((field, value) => {
        if (field === 'site_id') {
          siteId = value;
        }
        return chain;
      });
      chain.gte.callsFake(() => {
        isRange = true;
        return chain;
      });
      chain.lte.returns(chain);
      chain.then = (resolve) => {
        const flakyKey = isRange ? `${table}:range` : table;
        const flaky = flakyByTable[flakyKey];
        if (flaky && flaky.failuresLeft > 0) {
          flaky.failuresLeft -= 1;
          resolve({ count: null, error: flaky.error });
          return;
        }
        if (isRange && rangeErrorByTable[table]) {
          resolve({ count: null, error: rangeErrorByTable[table] });
          return;
        }
        if (!isRange && tableErrorByName[table]) {
          resolve({ count: null, error: tableErrorByName[table] });
          return;
        }
        const perSite = isRange ? rangeCountsBySiteTable : countsBySiteTable;
        const fallback = isRange ? rangeCountsByTable : countsByTable;
        const count = perSite[siteId]?.[table] ?? fallback[table] ?? 0;
        resolve({ count, error: null });
      };
      return chain;
    });
  };

  beforeEach(() => {
    countsByTable = {};
    rangeCountsByTable = {};
    countsBySiteTable = {};
    rangeCountsBySiteTable = {};
    tableErrorByName = {};
    rangeErrorByTable = {};
    flakyByTable = {};
    configStub = { isHandlerEnabledForSite: sinon.stub().returns(true) };
    postgrestStub = { from: sinon.stub() };
    installPostgrestMock();

    context = {
      dataAccess: {
        Site: {
          all: sinon.stub().resolves([]),
          findById: sinon.stub().resolves(null),
          findByBaseURL: sinon.stub().resolves(null),
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

  it('filters the check to one requested baseUrl', async () => {
    const targetSite = makeSite(TARGET_SITE_ID, 'https://base-url.example.com');
    context.dataAccess.Site.findByBaseURL.resolves(targetSite);
    countsByTable = { agentic_traffic: 1, agentic_traffic_daily: 1 };

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22', 'baseUrl=https://base-url.example.com'], slackContext);

    expect(context.dataAccess.Site.all).not.to.have.been.called;
    expect(context.dataAccess.Site.findById).not.to.have.been.called;
    expect(context.dataAccess.Site.findByBaseURL)
      .to.have.been.calledWith('https://base-url.example.com');
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('for site `https://base-url.example.com`');
    expect(output).to.include('Raw table: *1/1* sites, 1 rows');
    expect(output).to.not.include('hits');
  });

  it('reports when the requested baseUrl is not found', async () => {
    context.dataAccess.Site.findByBaseURL.resolves(null);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22', 'baseUrl=https://missing.example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWith(
      ':warning: No site found with baseUrl `https://missing.example.com`.',
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
    countsByTable = {
      agentic_traffic: 2,
      agentic_traffic_daily: 1,
      agentic_traffic_weekly: 1,
    };
    rangeCountsByTable = { agentic_traffic: 2 };

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-05-03', `siteId=${TARGET_SITE_ID}`], slackContext);

    expect(targetSite.getLatestAuditByAuditType).not.to.have.been.called;
    const tablesQueried = postgrestStub.from.args.map(([table]) => table);
    expect(tablesQueried).to.include.members([
      'agentic_traffic', 'agentic_traffic_daily', 'agentic_traffic_weekly',
    ]);
    // raw is queried twice — once for eq date, once for the week range
    expect(tablesQueried.filter((t) => t === 'agentic_traffic')).to.have.length(2);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Agentic Traffic DB Table Status — 2026-05-03');
    expect(output).to.include('Outcome: *DASHBOARD_READY*');
    expect(output).to.include('Raw table: *1/1* sites, 2 rows');
    expect(output).to.include('Daily table: *1/1* sites, 1 rows');
    expect(output).to.include('Raw week (2026-04-27..2026-05-03): *1/1* sites, 2 rows');
    expect(output).to.include('Weekly table (2026-04-27): *1/1* raw-week sites, 1 rows');
    expect(output).to.include('https://wknd.site');
    expect(output).to.not.include('hits');
  });

  it('caps long site detail lists and points to focused site checks', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-04-23T12:00:00Z').getTime());
    const sites = Array.from({ length: 9 }, (_, index) => {
      const siteId = `11111111-2222-3333-4444-${String(index + 1).padStart(12, '0')}`;
      return makeSite(siteId, `https://site-${index + 1}.example.com`);
    });
    context.dataAccess.Site.all.resolves(sites);
    countsByTable = { agentic_traffic: 1, agentic_traffic_daily: 1 };

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Dashboard-ready: *9*');
    expect(output).to.include('... 1 more. Re-run with `siteId=<siteId>` for focused details.');
  });

  it('reports missing daily rows when raw rows exist', async () => {
    context.dataAccess.Site.all.resolves([
      makeSite(TARGET_SITE_ID, 'https://raw-only.com'),
    ]);
    countsByTable = { agentic_traffic: 1 };

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
    expect(output).to.include('Raw table: *0/2* sites, 0 rows');
    expect(output).to.include('Daily table: *0/2* sites, 0 rows');
  });

  it('does not report no DB rows when only weekly rows exist for a closed Sunday', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-05-04T12:00:00Z').getTime());
    context.dataAccess.Site.all.resolves([
      makeSite(TARGET_SITE_ID, 'https://weekly-only.com'),
    ]);
    countsByTable = { agentic_traffic_weekly: 1 };

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-05-03'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Outcome: *ACTION_REQUIRED*');
    expect(output).to.not.include('Outcome: *NO_DB_ROWS_FOR_DATE*');
    expect(output).to.include('Weekly table (2026-04-27): *0/0* raw-week sites, 0 rows');
  });

  it('marks weekly as required for a closed Sunday', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-05-04T12:00:00Z').getTime());
    context.dataAccess.Site.all.resolves([
      makeSite(TARGET_SITE_ID, 'https://closed-sunday.com'),
    ]);
    countsByTable = {
      agentic_traffic: 1,
      agentic_traffic_daily: 1,
    };
    rangeCountsByTable = { agentic_traffic: 1 };

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-05-03'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Missing weekly serving: *1*');
    expect(output).to.include('Raw week (2026-04-27..2026-05-03): *1/1* sites, 1 rows');
    expect(output).to.include('Weekly table (2026-04-27): *0/1* raw-week sites, 0 rows');
    expect(output).to.include('missing: weekly');
  });

  it('marks weekly as required for a midweek date in a completed ISO week', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-05-04T12:00:00Z').getTime());
    context.dataAccess.Site.all.resolves([
      makeSite(TARGET_SITE_ID, 'https://midweek-completed.com'),
    ]);
    countsByTable = {
      agentic_traffic: 1,
      agentic_traffic_daily: 1,
    };
    rangeCountsByTable = { agentic_traffic: 1 };

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-29'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Agentic Traffic DB Table Status — 2026-04-29');
    expect(output).to.include('Missing weekly serving: *1*');
    expect(output).to.include('Raw week (2026-04-27..2026-05-03): *1/1* sites, 1 rows');
    expect(output).to.include('Weekly table (2026-04-27): *0/1* raw-week sites, 0 rows');
    expect(output).to.include('missing: weekly');
  });

  it('does not mark weekly missing for a midweek date in the current (incomplete) ISO week', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-05-06T12:00:00Z').getTime());
    context.dataAccess.Site.all.resolves([
      makeSite(TARGET_SITE_ID, 'https://midweek-current.com'),
    ]);
    countsByTable = {
      agentic_traffic: 1,
      agentic_traffic_daily: 1,
    };

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-05-05'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.not.include('Missing weekly serving:');
    expect(output).to.not.include('Raw week (2026-05-04..2026-05-10):');
  });

  it('does not mark weekly missing when a closed week has no raw week data for the site', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-05-04T12:00:00Z').getTime());
    context.dataAccess.Site.all.resolves([
      makeSite(TARGET_SITE_ID, 'https://no-raw-week.com'),
    ]);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-05-03'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Missing weekly serving: *0*');
    expect(output).to.include('Raw week (2026-04-27..2026-05-03): *0/1* sites, 0 rows');
    expect(output).to.include('Weekly table (2026-04-27): *0/0* raw-week sites, 0 rows');
  });

  it('handles many sites without batching and aggregates per-site counts', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-05-04T12:00:00Z').getTime());
    const sites = Array.from({ length: 30 }, (_, index) => {
      const siteId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      return makeSite(siteId, `https://batch-${index}.com`);
    });
    context.dataAccess.Site.all.resolves(sites);
    // First site has full data; others have nothing.
    const firstId = sites[0].getId();
    countsBySiteTable = {
      [firstId]: {
        agentic_traffic: 5,
        agentic_traffic_daily: 1,
        agentic_traffic_weekly: 1,
      },
    };
    rangeCountsBySiteTable = {
      [firstId]: { agentic_traffic: 35 },
    };

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-05-03'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Sites checked: *30*');
    expect(output).to.include('Raw table: *1/30* sites, 5 rows');
    expect(output).to.include('Raw week (2026-04-27..2026-05-03): *1/30* sites, 35 rows');
    expect(output).to.include('Weekly table (2026-04-27): *1/1* raw-week sites, 1 rows');
    expect(output).to.include('https://batch-0.com');
  });

  it('surfaces table query errors through the generic Slack error handler', async () => {
    const targetSite = makeSite(TARGET_SITE_ID, 'https://error.com');
    context.dataAccess.Site.all.resolves([targetSite]);
    tableErrorByName.agentic_traffic = { message: 'relation missing' };

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    expect(context.log.error).to.have.been.calledWith(
      'Error in check-agentic-traffic-db-status:',
      sinon.match.instanceOf(Error),
    );
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('relation missing');
  });

  it('surfaces raw week query errors through the generic Slack error handler', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-05-04T12:00:00Z').getTime());
    context.dataAccess.Site.all.resolves([
      makeSite(TARGET_SITE_ID, 'https://weekly-error.com'),
    ]);
    countsByTable = {
      agentic_traffic: 1,
      agentic_traffic_daily: 1,
    };
    rangeErrorByTable.agentic_traffic = { message: 'weekly range failed' };

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-05-03'], slackContext);
    clock.restore();

    expect(context.log.error).to.have.been.calledWith(
      'Error in check-agentic-traffic-db-status:',
      sinon.match.instanceOf(Error),
    );
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('weekly range failed');
  });

  it('retries transient gateway errors and recovers', async () => {
    context.dataAccess.Site.all.resolves([
      makeSite(TARGET_SITE_ID, 'https://flaky.com'),
    ]);
    flakyByTable.agentic_traffic = {
      failuresLeft: 2,
      error: { message: '502 Bad Gateway' },
    };
    countsByTable = { agentic_traffic: 7, agentic_traffic_daily: 1 };

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    expect(context.log.error).not.to.have.been.called;
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Raw table: *1/1* sites, 7 rows');
    // 3 attempts on agentic_traffic eq-date (2 failures + 1 success), plus
    // 1 follow-up call for the raw range-week query.
    const rawCalls = postgrestStub.from.args.filter(([t]) => t === 'agentic_traffic');
    expect(rawCalls.length).to.equal(4);
  });

  it('does not retry non-transient errors', async () => {
    context.dataAccess.Site.all.resolves([
      makeSite(TARGET_SITE_ID, 'https://strict.com'),
    ]);
    // Non-transient (no 5xx / gateway / timeout markers) — fails on first try.
    tableErrorByName.agentic_traffic = { message: 'relation does not exist' };

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    expect(context.log.error).to.have.been.calledWith(
      'Error in check-agentic-traffic-db-status:',
      sinon.match.instanceOf(Error),
    );
    const rawCalls = postgrestStub.from.args.filter(([t]) => t === 'agentic_traffic');
    expect(rawCalls.length).to.equal(1);
  });
});
