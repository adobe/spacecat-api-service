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

const TARGET_SITE_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_SITE_ID = '22222222-3333-4444-5555-555555555555';

const HANDLERS = {
  raw: 'wrpc_import_agentic_traffic',
  daily: 'wrpc_refresh_agentic_traffic_daily',
  weekly: 'wrpc_refresh_agentic_traffic_weekly',
};

const makeSite = (id, baseURL) => ({
  getId: () => id,
  getBaseURL: () => baseURL,
  getLatestAuditByAuditType: sinon.stub().resolves(null),
});

// Chainable thenable PostgREST mock: records filters, applies them on await.
// Supports the per-handler cs queries (eq handler_name, gte/lt projected_at,
// gt output_count, contains on a jsonb metadata path).
const makePostgrest = (allRows, error = null) => {
  const from = sinon.stub().callsFake(() => {
    const f = {
      scope: null,
      handlerEq: null,
      gteAt: null,
      ltAt: null,
      skipped: null,
      gtOutput: null,
      contains: [],
    };
    const chain = {};
    chain.select = sinon.stub().callsFake(() => chain);
    chain.in = sinon.stub().callsFake((c, v) => {
      if (c === 'scope_prefix') {
        f.scope = v;
      }
      return chain;
    });
    chain.eq = sinon.stub().callsFake((c, v) => {
      if (c === 'handler_name') {
        f.handlerEq = v;
      }
      if (c === 'skipped') {
        f.skipped = v;
      }
      return chain;
    });
    chain.gte = sinon.stub().callsFake((c, v) => {
      if (c === 'projected_at') {
        f.gteAt = v;
      }
      return chain;
    });
    chain.lt = sinon.stub().callsFake((c, v) => {
      if (c === 'projected_at') {
        f.ltAt = v;
      }
      return chain;
    });
    chain.gt = sinon.stub().callsFake((c, v) => {
      if (c === 'output_count') {
        f.gtOutput = v;
      }
      return chain;
    });
    chain.contains = sinon.stub().callsFake((c, v) => {
      f.contains.push([c, v]);
      return chain;
    });
    const passes = (r) => {
      if (f.scope && !f.scope.includes(r.scope_prefix)) {
        return false;
      }
      if (f.handlerEq && r.handler_name !== f.handlerEq) {
        return false;
      }
      if (f.gteAt && r.projected_at < f.gteAt) {
        return false;
      }
      if (f.ltAt && r.projected_at >= f.ltAt) {
        return false;
      }
      if (f.skipped != null && r.skipped !== f.skipped) {
        return false;
      }
      if (f.gtOutput != null && !(Number(r.output_count ?? 0) > f.gtOutput)) {
        return false;
      }
      return f.contains.every(([col, json]) => {
        const key = col.split('->').pop();
        const have = r.metadata?.[key] ?? [];
        return JSON.parse(json).every((x) => have.includes(x));
      });
    };
    chain.then = (resolve) => {
      resolve(error ? { data: null, error } : { data: allRows.filter(passes), error: null });
    };
    return chain;
  });
  return { from };
};

describe('CheckAgenticTrafficDbStatusCommand', () => {
  let context;
  let slackContext;
  let configStub;

  beforeEach(() => {
    configStub = { isHandlerEnabledForSite: sinon.stub().returns(true) };
    context = {
      dataAccess: {
        Site: {
          all: sinon.stub().resolves([]),
          findById: sinon.stub().resolves(null),
          findByBaseURL: sinon.stub().resolves(null),
        },
        Configuration: { findLatest: sinon.stub().resolves(configStub) },
        services: { postgrestClient: makePostgrest([]) },
      },
      log: { error: sinon.stub(), warn: sinon.stub() },
    };
    slackContext = { say: sinon.stub().resolves() };
  });

  afterEach(() => sinon.restore());

  it('reports DASHBOARD_READY when all sites have raw + matching daily/weekly metadata', async () => {
    // Clock past the closed week so weeklyExpected = true and weekly is required.
    const clock = sinon.useFakeTimers(new Date('2026-05-26T12:00:00Z').getTime());
    context.dataAccess.Site.all.resolves([makeSite(TARGET_SITE_ID, 'https://wknd.site')]);
    context.dataAccess.services.postgrestClient = makePostgrest([
      {
        scope_prefix: TARGET_SITE_ID,
        handler_name: HANDLERS.raw,
        projected_at: '2026-05-20T06:46:53Z',
        metadata: {},
        skipped: false,
      },
      {
        scope_prefix: TARGET_SITE_ID,
        handler_name: HANDLERS.daily,
        projected_at: '2026-05-20T06:54:13Z',
        metadata: { dailyRefreshDates: ['2026-05-19'] },
        skipped: false,
      },
      {
        scope_prefix: TARGET_SITE_ID,
        handler_name: HANDLERS.weekly,
        projected_at: '2026-05-25T07:10:00Z',
        metadata: { weeklyRefreshWeeks: ['2026-05-18'] },
        skipped: false,
      },
    ]);

    await CheckAgenticTrafficDbStatusCommand(context)
      .handleExecution(['2026-05-19'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Outcome: *DASHBOARD_READY*');
    expect(output).to.include('Dashboard-ready: *1/1*');
    expect(output).to.include('Missing raw projection: *0*');
    expect(output).to.include('Missing daily refresh: *0*');
    expect(output).to.include('Missing weekly refresh');
  });

  it('credits a backfill whose refresh was projected weeks after the traffic date', async () => {
    // Backfill ran 2026-06-05 but its metadata covers 2026-05-19. The old
    // projected_at < date+7 window missed this; cs-by-date matching catches it.
    const clock = sinon.useFakeTimers(new Date('2026-06-10T12:00:00Z').getTime());
    context.dataAccess.Site.all.resolves([makeSite(TARGET_SITE_ID, 'https://backfilled.site')]);
    context.dataAccess.services.postgrestClient = makePostgrest([
      {
        scope_prefix: TARGET_SITE_ID,
        handler_name: HANDLERS.daily,
        projected_at: '2026-06-05T14:13:00Z',
        metadata: { dailyRefreshDates: ['2026-05-19'] },
        skipped: false,
      },
      {
        scope_prefix: TARGET_SITE_ID,
        handler_name: HANDLERS.weekly,
        projected_at: '2026-06-05T14:14:00Z',
        metadata: { weeklyRefreshWeeks: ['2026-05-18'] },
        skipped: false,
      },
    ]);

    await CheckAgenticTrafficDbStatusCommand(context)
      .handleExecution(['2026-05-19'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Outcome: *DASHBOARD_READY*');
    expect(output).to.include('Missing raw projection: *0*');
    expect(output).to.include('Missing daily refresh: *0*');
  });

  it('reports NO_DB_ROWS_FOR_DATE when zero audit rows match', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-05-26T12:00:00Z').getTime());
    context.dataAccess.Site.all.resolves([
      makeSite(TARGET_SITE_ID, 'https://wknd.site'),
      makeSite(OTHER_SITE_ID, 'https://other.site'),
    ]);
    // Empty audit corpus: projector never ran for these sites.
    context.dataAccess.services.postgrestClient = makePostgrest([]);

    await CheckAgenticTrafficDbStatusCommand(context)
      .handleExecution(['2026-05-19'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Outcome: *NO_DB_ROWS_FOR_DATE*');
    expect(output).to.include('Missing raw projection: *2*');
  });

  it('flags raw AND daily as missing when audit rows exist but lack per-date evidence for dateStr', async () => {
    // Raw projection_audit rows carry no per-date metadata, so a raw row alone
    // cannot prove that *dateStr* was covered (it could be for any other date
    // in the lookup window). When daily refresh metadata also lacks dateStr,
    // and the raw row has no positive output_count fallback, both must be
    // reported missing. Regression for the bug where any raw row in the window
    // was permissively credited as "raw OK for dateStr".
    const clock = sinon.useFakeTimers(new Date('2026-05-26T12:00:00Z').getTime());
    context.dataAccess.Site.all.resolves([makeSite(TARGET_SITE_ID, 'https://wknd.site')]);
    context.dataAccess.services.postgrestClient = makePostgrest([
      {
        scope_prefix: TARGET_SITE_ID,
        handler_name: HANDLERS.raw,
        projected_at: '2026-05-20T06:46:00Z',
        output_count: 0,
        metadata: {},
        skipped: false,
      },
      {
        scope_prefix: TARGET_SITE_ID,
        handler_name: HANDLERS.daily,
        projected_at: '2026-05-20T06:54:00Z',
        metadata: { dailyRefreshDates: ['2026-05-18'] }, // wrong date
        skipped: false,
      },
    ]);

    await CheckAgenticTrafficDbStatusCommand(context)
      .handleExecution(['2026-05-19'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Missing raw projection: *1*');
    expect(output).to.include('Missing daily refresh: *1*');
    expect(output).to.include('missing: raw, daily');
  });

  it('flags only daily as missing when raw ran post-day with positive output_count but daily metadata does not cover dateStr', async () => {
    // The legitimate "raw OK, daily refresh failed" diagnostic: raw audit row
    // has projected_at >= dateStr+1 day UTC and output_count > 0 (the raw
    // projector runs the day after the traffic day), but the daily refresh
    // did not record dateStr in its metadata. Raw should count, daily shouldn't.
    const clock = sinon.useFakeTimers(new Date('2026-05-26T12:00:00Z').getTime());
    context.dataAccess.Site.all.resolves([makeSite(TARGET_SITE_ID, 'https://raw-ok.site')]);
    context.dataAccess.services.postgrestClient = makePostgrest([
      {
        scope_prefix: TARGET_SITE_ID,
        handler_name: HANDLERS.raw,
        projected_at: '2026-05-20T06:46:00Z', // dateStr+1 day
        output_count: 1234,
        metadata: {},
        skipped: false,
      },
      {
        scope_prefix: TARGET_SITE_ID,
        handler_name: HANDLERS.daily,
        projected_at: '2026-05-20T06:54:00Z',
        metadata: { dailyRefreshDates: ['2026-05-18'] }, // wrong date
        skipped: false,
      },
    ]);

    await CheckAgenticTrafficDbStatusCommand(context)
      .handleExecution(['2026-05-19'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Missing raw projection: *0*');
    expect(output).to.include('Missing daily refresh: *1*');
    expect(output).to.include('missing: daily');
  });

  it('does not credit raw when projected_at is before dateStr+1 day UTC even with positive output_count', async () => {
    // A raw row whose projected_at falls on dateStr or earlier cannot have
    // covered dateStr — the raw projector runs the day after the traffic day.
    // Without daily refresh proof for dateStr, raw must be reported missing.
    const clock = sinon.useFakeTimers(new Date('2026-05-26T12:00:00Z').getTime());
    context.dataAccess.Site.all.resolves([makeSite(TARGET_SITE_ID, 'https://early-raw.site')]);
    context.dataAccess.services.postgrestClient = makePostgrest([
      {
        scope_prefix: TARGET_SITE_ID,
        handler_name: HANDLERS.raw,
        projected_at: '2026-05-19T06:46:00Z', // same day as dateStr
        output_count: 5000,
        metadata: {},
        skipped: false,
      },
    ]);

    await CheckAgenticTrafficDbStatusCommand(context)
      .handleExecution(['2026-05-19'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Missing raw projection: *1*');
    expect(output).to.include('Missing daily refresh: *1*');
  });

  it('skips weekly check for traffic dates in the current (incomplete) ISO week', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-05-20T12:00:00Z').getTime());
    context.dataAccess.Site.all.resolves([makeSite(TARGET_SITE_ID, 'https://midweek.site')]);
    context.dataAccess.services.postgrestClient = makePostgrest([
      {
        scope_prefix: TARGET_SITE_ID,
        handler_name: HANDLERS.raw,
        projected_at: '2026-05-20T06:46:00Z',
        metadata: {},
        skipped: false,
      },
      {
        scope_prefix: TARGET_SITE_ID,
        handler_name: HANDLERS.daily,
        projected_at: '2026-05-20T06:54:00Z',
        metadata: { dailyRefreshDates: ['2026-05-19'] },
        skipped: false,
      },
    ]);

    await CheckAgenticTrafficDbStatusCommand(context)
      .handleExecution(['2026-05-19'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Outcome: *DASHBOARD_READY*');
    expect(output).to.not.include('Missing weekly refresh');
  });

  it('excludes rows where skipped=true', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-05-26T12:00:00Z').getTime());
    context.dataAccess.Site.all.resolves([makeSite(TARGET_SITE_ID, 'https://skipped.site')]);
    context.dataAccess.services.postgrestClient = makePostgrest([
      // A skipped row should NOT be counted as a successful projection run.
      {
        scope_prefix: TARGET_SITE_ID,
        handler_name: HANDLERS.raw,
        projected_at: '2026-05-20T06:46:00Z',
        metadata: {},
        skipped: true,
      },
    ]);

    await CheckAgenticTrafficDbStatusCommand(context)
      .handleExecution(['2026-05-19'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Missing raw projection: *1*');
  });

  it('warns and short-circuits when PostgREST is unavailable', async () => {
    context.dataAccess.services = {};
    await CheckAgenticTrafficDbStatusCommand(context)
      .handleExecution(['2026-05-19'], slackContext);

    expect(slackContext.say).to.have.been.calledWith(
      ':warning: PostgREST client is unavailable; cannot check projection_audit.',
    );
  });

  it('reports when no enabled sites match the requested scope', async () => {
    configStub.isHandlerEnabledForSite.returns(false);
    context.dataAccess.Site.all.resolves([makeSite(TARGET_SITE_ID, 'https://nope.site')]);

    await CheckAgenticTrafficDbStatusCommand(context)
      .handleExecution(['2026-05-19'], slackContext);

    expect(slackContext.say).to.have.been.calledWith(
      ':information_source: No sites have cdn-logs-report enabled.',
    );
  });

  it('surfaces non-transient PostgREST errors through the generic Slack error handler', async () => {
    context.dataAccess.Site.all.resolves([makeSite(TARGET_SITE_ID, 'https://err.site')]);
    context.dataAccess.services.postgrestClient = makePostgrest([], { message: 'relation missing' });

    await CheckAgenticTrafficDbStatusCommand(context)
      .handleExecution(['2026-05-19'], slackContext);

    expect(context.log.error).to.have.been.calledWith(
      'Error in check-agentic-traffic-db-status:',
      sinon.match.instanceOf(Error),
    );
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('relation missing');
  });

  it('retries transient errors (EBUSY) and recovers without failing the report', async () => {
    // shouldAdvanceTime auto-fires the retry's setTimeout under the fake clock.
    const clock = sinon.useFakeTimers({
      now: new Date('2026-05-26T12:00:00Z').getTime(),
      shouldAdvanceTime: true,
    });
    context.dataAccess.Site.all.resolves([makeSite(TARGET_SITE_ID, 'https://flaky.site')]);
    const goodRows = [
      {
        scope_prefix: TARGET_SITE_ID,
        handler_name: HANDLERS.raw,
        projected_at: '2026-05-20T06:46:00Z',
        metadata: {},
        skipped: false,
      },
      {
        scope_prefix: TARGET_SITE_ID,
        handler_name: HANDLERS.daily,
        projected_at: '2026-05-20T06:54:00Z',
        metadata: { dailyRefreshDates: ['2026-05-19'] },
        skipped: false,
      },
      {
        scope_prefix: TARGET_SITE_ID,
        handler_name: HANDLERS.weekly,
        projected_at: '2026-05-25T07:10:00Z',
        metadata: { weeklyRefreshWeeks: ['2026-05-18'] },
        skipped: false,
      },
    ];
    const flaky = makePostgrest(goodRows);
    // First call resolves with a transient EBUSY error in the result envelope
    // (this is how supabase-js surfaces RPC failures, not as a rejected Promise).
    const originalFrom = flaky.from;
    let firstCall = true;
    flaky.from = sinon.stub().callsFake((...args) => {
      const chain = originalFrom(...args);
      if (firstCall) {
        firstCall = false;
        const ebusy = Object.assign(
          new Error('getaddrinfo EBUSY data-svc-balanced.internal'),
          { code: 'EBUSY' },
        );
        chain.then = (_resolve, reject) => {
          reject(ebusy);
        };
      }
      return chain;
    });
    context.dataAccess.services.postgrestClient = flaky;

    await CheckAgenticTrafficDbStatusCommand(context)
      .handleExecution(['2026-05-19'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Outcome: *DASHBOARD_READY*');
    // daily query: 1 transient failure + 1 retry; then weekly + raw queries.
    expect(flaky.from.callCount).to.equal(4);
  });

  it('defaults to yesterday when no date argument is given', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-05-26T12:00:00Z').getTime());
    context.dataAccess.Site.all.resolves([makeSite(TARGET_SITE_ID, 'https://wknd.site')]);

    await CheckAgenticTrafficDbStatusCommand(context).handleExecution([], slackContext);
    clock.restore();

    expect(slackContext.say.firstCall.args[0]).to.include('*2026-05-25*');
  });

  it('gives up on non-transient errors without retry', async () => {
    context.dataAccess.Site.all.resolves([makeSite(TARGET_SITE_ID, 'https://err.site')]);
    const pg = makePostgrest([]);
    // Rejection with a non-transient code: must propagate after the first attempt.
    const originalFrom = pg.from;
    pg.from = sinon.stub().callsFake((...args) => {
      const chain = originalFrom(...args);
      chain.eq = sinon.stub().rejects(Object.assign(
        new Error('permission denied'),
        { code: 'PGRST301' },
      ));
      return chain;
    });
    context.dataAccess.services.postgrestClient = pg;

    await CheckAgenticTrafficDbStatusCommand(context)
      .handleExecution(['2026-05-19'], slackContext);

    expect(pg.from.callCount).to.equal(1); // no retry for non-transient
    expect(context.log.error).to.have.been.called;
  });

  it('chunks site IDs across multiple PostgREST calls (250 sites -> 2 chunks)', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-05-26T12:00:00Z').getTime());
    const sites = Array.from({ length: 250 }, (_, i) => {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      return makeSite(id, `https://site-${i}.example.com`);
    });
    context.dataAccess.Site.all.resolves(sites);
    const audits = sites.flatMap((s) => [
      {
        scope_prefix: s.getId(),
        handler_name: HANDLERS.raw,
        projected_at: '2026-05-20T06:46:00Z',
        metadata: {},
        skipped: false,
      },
      {
        scope_prefix: s.getId(),
        handler_name: HANDLERS.daily,
        projected_at: '2026-05-20T06:54:00Z',
        metadata: { dailyRefreshDates: ['2026-05-19'] },
        skipped: false,
      },
      {
        scope_prefix: s.getId(),
        handler_name: HANDLERS.weekly,
        projected_at: '2026-05-25T07:10:00Z',
        metadata: { weeklyRefreshWeeks: ['2026-05-18'] },
        skipped: false,
      },
    ]);
    const postgrest = makePostgrest(audits);
    context.dataAccess.services.postgrestClient = postgrest;

    await CheckAgenticTrafficDbStatusCommand(context)
      .handleExecution(['2026-05-19'], slackContext);
    clock.restore();

    // 250 sites, chunk size 150 -> 2 chunks; 3 per-handler queries each = 6 calls.
    const calls = postgrest.from.callCount;
    expect(calls).to.equal(6);
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Outcome: *DASHBOARD_READY*');
    expect(output).to.include('Dashboard-ready: *250/250*');
  });
});
