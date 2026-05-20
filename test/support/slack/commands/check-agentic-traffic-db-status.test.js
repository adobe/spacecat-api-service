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

// Builds a PostgREST mock whose query chain resolves to audit rows filtered by
// the scope_prefix IN(...) values used in each call. This matches PostgREST's
// real behavior and lets a single test exercise the chunking path: each chunk
// produces its own filtered response, and rows are correctly merged.
const makePostgrest = (allRows, error = null) => {
  const from = sinon.stub().callsFake(() => {
    let chunkSiteIds = [];
    const chain = {
      select: sinon.stub(),
      in: sinon.stub().callsFake((column, values) => {
        if (column === 'scope_prefix') {
          chunkSiteIds = values;
        }
        return chain;
      }),
      gte: sinon.stub(),
      lt: sinon.stub(),
      eq: sinon.stub(),
    };
    chain.select.returns(chain);
    chain.gte.returns(chain);
    chain.lt.returns(chain);
    // Defer the filter until eq() is called so the closure captures the
    // chunkSiteIds chosen by the in() call, not the empty initial value.
    chain.eq.callsFake(() => Promise.resolve(error
      ? { data: null, error }
      : {
        data: allRows.filter((r) => chunkSiteIds.includes(r.scope_prefix)),
        error: null,
      }));
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

  it('reports DASHBOARD_READY when every enabled site has all expected projections', async () => {
    // Clock is after the ISO week of 2026-05-19 (2026-05-18..2026-05-24) ends,
    // so the weekly projection IS expected and must be present.
    const clock = sinon.useFakeTimers(new Date('2026-05-26T12:00:00Z').getTime());
    const site = makeSite(TARGET_SITE_ID, 'https://wknd.site');
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.services.postgrestClient = makePostgrest([
      { scope_prefix: TARGET_SITE_ID, handler_name: HANDLERS.raw },
      { scope_prefix: TARGET_SITE_ID, handler_name: HANDLERS.daily },
      { scope_prefix: TARGET_SITE_ID, handler_name: HANDLERS.weekly },
    ]);

    await CheckAgenticTrafficDbStatusCommand(context)
      .handleExecution(['2026-05-19'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Outcome: *DASHBOARD_READY*');
    expect(output).to.include('Dashboard-ready: *1/1*');
    expect(output).to.include('Missing raw projection: *0*');
  });

  it('reports ACTION_REQUIRED and lists which handlers are missing per site', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-05-26T12:00:00Z').getTime());
    const completeSite = makeSite(TARGET_SITE_ID, 'https://complete.site');
    const partialSite = makeSite(OTHER_SITE_ID, 'https://partial.site');
    context.dataAccess.Site.all.resolves([completeSite, partialSite]);
    context.dataAccess.services.postgrestClient = makePostgrest([
      { scope_prefix: TARGET_SITE_ID, handler_name: HANDLERS.raw },
      { scope_prefix: TARGET_SITE_ID, handler_name: HANDLERS.daily },
      { scope_prefix: TARGET_SITE_ID, handler_name: HANDLERS.weekly },
      // partial site has no rows at all - missing raw, daily, AND weekly
    ]);

    await CheckAgenticTrafficDbStatusCommand(context)
      .handleExecution(['2026-05-19'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Outcome: *ACTION_REQUIRED*');
    expect(output).to.include('Missing raw projection: *1*');
    expect(output).to.include('Missing daily refresh: *1*');
    expect(output).to.include('Missing weekly refresh');
    expect(output).to.include('https://partial.site');
    expect(output).to.include('missing: raw, daily, weekly');
  });

  it('defaults to yesterday when no date argument is given', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-05-26T12:00:00Z').getTime());
    context.dataAccess.Site.all.resolves([makeSite(TARGET_SITE_ID, 'https://wknd.site')]);

    await CheckAgenticTrafficDbStatusCommand(context)
      .handleExecution([], slackContext);
    clock.restore();

    expect(slackContext.say.firstCall.args[0]).to.include('*2026-05-25*');
  });

  it('skips weekly check for traffic dates in the current (incomplete) ISO week', async () => {
    // ISO week containing 2026-05-19 = 2026-05-18..2026-05-24. "Now" is mid-week.
    const clock = sinon.useFakeTimers(new Date('2026-05-20T12:00:00Z').getTime());
    const site = makeSite(TARGET_SITE_ID, 'https://midweek.site');
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.services.postgrestClient = makePostgrest([
      { scope_prefix: TARGET_SITE_ID, handler_name: HANDLERS.raw },
      { scope_prefix: TARGET_SITE_ID, handler_name: HANDLERS.daily },
      // no weekly row - should not be flagged because the week is not complete
    ]);

    await CheckAgenticTrafficDbStatusCommand(context)
      .handleExecution(['2026-05-19'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Outcome: *DASHBOARD_READY*');
    expect(output).to.not.include('Missing weekly refresh');
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

  it('surfaces PostgREST query errors through the generic Slack error handler', async () => {
    const site = makeSite(TARGET_SITE_ID, 'https://err.site');
    context.dataAccess.Site.all.resolves([site]);
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

  it('chunks site IDs across multiple PostgREST calls and merges results', async () => {
    // 250 sites > 150 chunk size -> 2 PostgREST calls. Every site has all 3
    // handlers in projection_audit, so the result must still be DASHBOARD_READY.
    const clock = sinon.useFakeTimers(new Date('2026-05-26T12:00:00Z').getTime());
    const sites = Array.from({ length: 250 }, (_, i) => {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      return makeSite(id, `https://site-${i}.example.com`);
    });
    context.dataAccess.Site.all.resolves(sites);
    const audits = sites.flatMap((s) => [
      { scope_prefix: s.getId(), handler_name: HANDLERS.raw },
      { scope_prefix: s.getId(), handler_name: HANDLERS.daily },
      { scope_prefix: s.getId(), handler_name: HANDLERS.weekly },
    ]);
    const postgrest = makePostgrest(audits);
    context.dataAccess.services.postgrestClient = postgrest;

    await CheckAgenticTrafficDbStatusCommand(context)
      .handleExecution(['2026-05-19'], slackContext);
    clock.restore();

    expect(postgrest.from.callCount).to.equal(2);
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Outcome: *DASHBOARD_READY*');
    expect(output).to.include('Dashboard-ready: *250/250*');
  });
});
