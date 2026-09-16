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
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import {
  run,
  countStuckInProgress,
  countNeedsReauthBacklog,
  vaultOpts,
  STUCK_IN_PROGRESS_METRIC,
  NEEDS_REAUTH_BACKLOG_METRIC,
  STUCK_JOB_DEADLINE_MS_ENV,
  DEFAULT_STUCK_JOB_DEADLINE_MS,
} from '../../src/serenity-market-probe/index.js';

use(chaiAsPromised);

const SEMRUSH_MARKET_JOB_TYPE = 'serenity-generate-semrush-market';

const hasFilter = (state, op, col, val) => state.filters
  .some(([o, c, v]) => o === op && c === col && v === val);

/**
 * A minimal, chainable PostgREST-client double. Each `from()` starts a fresh
 * builder that records the filters applied (captured on `client.states`) and,
 * when awaited, resolves to the `{ count, error }` decided by `resolver(state)`.
 * Mirrors the head-only, count-exact query shape the probe issues.
 */
function makeClient(resolver) {
  const states = [];
  return {
    states,
    from(table) {
      const state = {
        table, select: null, selectOpts: null, filters: [],
      };
      states.push(state);
      const builder = {
        select(sel, opts) {
          state.select = sel;
          state.selectOpts = opts;
          return builder;
        },
        eq(col, val) {
          state.filters.push(['eq', col, val]);
          return builder;
        },
        lt(col, val) {
          state.filters.push(['lt', col, val]);
          return builder;
        },
        then(onFulfilled, onRejected) {
          return Promise.resolve(resolver(state)).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
}

/** The single recorded query state whose status filter matches. */
const stateForStatus = (client, status) => client.states
  .find((s) => hasFilter(s, 'eq', 'status', status));

function makeLog() {
  return {
    info: sinon.spy(),
    warn: sinon.spy(),
    error: sinon.spy(),
    debug: sinon.spy(),
  };
}

describe('serenity-market-probe', () => {
  let consoleStub;
  let emitted;

  beforeEach(() => {
    emitted = [];
    consoleStub = sinon.stub(console, 'log').callsFake((line) => emitted.push(line));
  });

  afterEach(() => {
    consoleStub.restore();
    sinon.restore();
  });

  const parsedMetrics = () => emitted.map((l) => JSON.parse(l));

  describe('countStuckInProgress', () => {
    it('filters IN_PROGRESS serenity-market jobs older than the deadline boundary', async () => {
      const now = Date.parse('2026-09-14T12:00:00.000Z');
      const deadlineMs = 60 * 60 * 1000;
      const client = makeClient(() => ({ count: 3, error: null }));

      const count = await countStuckInProgress(client, now, deadlineMs);

      expect(count).to.equal(3);
      const [state] = client.states;
      expect(state.table).to.equal('async_jobs');
      // head-only count query: no rows transferred.
      expect(state.selectOpts).to.deep.equal({ count: 'exact', head: true });
      expect(hasFilter(state, 'eq', 'status', 'IN_PROGRESS')).to.equal(true);
      expect(hasFilter(state, 'eq', 'metadata->>jobType', SEMRUSH_MARKET_JOB_TYPE)).to.equal(true);
      // Boundary: started_at strictly older than now - deadline.
      expect(hasFilter(state, 'lt', 'started_at', '2026-09-14T11:00:00.000Z')).to.equal(true);
    });

    it('throws when the query returns an error', async () => {
      const client = makeClient(() => ({ count: null, error: { message: 'boom' } }));
      await expect(countStuckInProgress(client, Date.now(), 1000))
        .to.be.rejectedWith(/count query failed: boom/);
    });

    it('throws when the query returns no numeric count', async () => {
      const client = makeClient(() => ({ count: null, error: null }));
      await expect(countStuckInProgress(client, Date.now(), 1000))
        .to.be.rejectedWith(/no numeric count/);
    });
  });

  describe('countNeedsReauthBacklog', () => {
    it('filters FAILED serenity-market jobs whose error.code is NEEDS_REAUTH', async () => {
      const client = makeClient(() => ({ count: 7, error: null }));

      const count = await countNeedsReauthBacklog(client);

      expect(count).to.equal(7);
      const [state] = client.states;
      expect(state.selectOpts).to.deep.equal({ count: 'exact', head: true });
      expect(hasFilter(state, 'eq', 'status', 'FAILED')).to.equal(true);
      expect(hasFilter(state, 'eq', 'metadata->>jobType', SEMRUSH_MARKET_JOB_TYPE)).to.equal(true);
      expect(hasFilter(state, 'eq', 'error->>code', 'NEEDS_REAUTH')).to.equal(true);
    });
  });

  /** A client that answers the stuck query and the reauth query independently. */
  const dualClient = ({ stuck, reauth }) => makeClient((state) => {
    if (hasFilter(state, 'eq', 'status', 'IN_PROGRESS')) {
      return stuck;
    }
    if (hasFilter(state, 'eq', 'status', 'FAILED')) {
      return reauth;
    }
    return { count: 0, error: null };
  });

  const ctxWith = (client, env = { AWS_ENV: 'prod' }) => ({
    log: makeLog(),
    env,
    dataAccess: { services: { postgrestClient: client } },
  });

  describe('run', () => {
    it('emits both metrics with the infra alarm namespace + Environment dimension', async () => {
      const client = dualClient({
        stuck: { count: 2, error: null },
        reauth: { count: 5, error: null },
      });
      const res = await run(null, ctxWith(client));

      expect(res.status).to.equal(200);
      const metrics = parsedMetrics();
      expect(metrics).to.have.length(2);

      const stuck = metrics.find((m) => m[STUCK_IN_PROGRESS_METRIC] !== undefined);
      const reauth = metrics.find((m) => m[NEEDS_REAUTH_BACKLOG_METRIC] !== undefined);
      expect(stuck[STUCK_IN_PROGRESS_METRIC]).to.equal(2);
      expect(reauth[NEEDS_REAUTH_BACKLOG_METRIC]).to.equal(5);
      // Contract with modules/serenity_market_worker/alarms.tf.
      // eslint-disable-next-line no-underscore-dangle
      expect(stuck._aws.CloudWatchMetrics[0].Namespace).to.equal('SpacecatSerenityMarketWorker');
      // eslint-disable-next-line no-underscore-dangle
      expect(reauth._aws.CloudWatchMetrics[0].Namespace).to.equal('SpacecatSerenityMarketWorker');
      expect(stuck.Environment).to.equal('prod');
      expect(reauth.Environment).to.equal('prod');
    });

    it('emits an explicit 0 when there are no matching jobs', async () => {
      const client = dualClient({
        stuck: { count: 0, error: null },
        reauth: { count: 0, error: null },
      });
      await run(null, ctxWith(client));

      const metrics = parsedMetrics();
      expect(metrics).to.have.length(2);
      const stuck = metrics.find((m) => m[STUCK_IN_PROGRESS_METRIC] !== undefined);
      const reauth = metrics.find((m) => m[NEEDS_REAUTH_BACKLOG_METRIC] !== undefined);
      expect(stuck[STUCK_IN_PROGRESS_METRIC]).to.equal(0);
      expect(reauth[NEEDS_REAUTH_BACKLOG_METRIC]).to.equal(0);
    });

    it('skips a metric whose query fails (never emits a false 0) and still emits the other', async () => {
      const client = dualClient({
        stuck: { count: null, error: { message: 'db down' } },
        reauth: { count: 4, error: null },
      });
      const ctx = ctxWith(client);
      const res = await run(null, ctx);

      expect(res.status).to.equal(200);
      const metrics = parsedMetrics();
      // Only the reauth metric is emitted; the stuck query failed and is skipped.
      expect(metrics).to.have.length(1);
      expect(metrics[0][NEEDS_REAUTH_BACKLOG_METRIC]).to.equal(4);
      expect(ctx.log.error.calledWithMatch(/StuckInProgressJobs scan failed/)).to.equal(true);
    });

    it('does not crash and emits nothing when the PostgREST client is unavailable', async () => {
      const ctx = {
        log: makeLog(),
        env: { AWS_ENV: 'dev' },
        dataAccess: { services: {} },
      };
      const res = await run(null, ctx);

      expect(res.status).to.equal(200);
      expect(emitted).to.have.length(0);
      expect(ctx.log.error.calledWithMatch(/cannot run probe/)).to.equal(true);
    });

    it('honors the STUCK_JOB_DEADLINE_MS override for the stuck boundary', async () => {
      const client = dualClient({
        stuck: { count: 0, error: null },
        reauth: { count: 0, error: null },
      });
      const now = Date.now();
      const env = { AWS_ENV: 'prod', [STUCK_JOB_DEADLINE_MS_ENV]: '120000' };
      await run(null, ctxWith(client, env));

      const state = stateForStatus(client, 'IN_PROGRESS');
      const ltFilter = state.filters.find(([op, col]) => op === 'lt' && col === 'started_at');
      const boundary = Date.parse(ltFilter[2]);
      // 120s override, not the 1h default.
      expect(now - boundary).to.be.closeTo(120000, 2000);
      expect(now - boundary).to.not.be.closeTo(DEFAULT_STUCK_JOB_DEADLINE_MS, 2000);
    });

    it('falls back to the default deadline when the override is not a positive integer', async () => {
      const client = dualClient({
        stuck: { count: 0, error: null },
        reauth: { count: 0, error: null },
      });
      const now = Date.now();
      const env = { AWS_ENV: 'prod', [STUCK_JOB_DEADLINE_MS_ENV]: 'nonsense' };
      await run(null, ctxWith(client, env));

      const state = stateForStatus(client, 'IN_PROGRESS');
      const ltFilter = state.filters.find(([op, col]) => op === 'lt' && col === 'started_at');
      const boundary = Date.parse(ltFilter[2]);
      expect(now - boundary).to.be.closeTo(DEFAULT_STUCK_JOB_DEADLINE_MS, 2000);
    });
  });

  describe('vaultOpts', () => {
    it('derives the env-scoped api-service Vault path from AWS_ENV', () => {
      expect(vaultOpts.bootstrapPath).to.equal('/mysticat/bootstrap/api-service');
      expect(vaultOpts.name({ env: { AWS_ENV: 'stage' } })).to.equal('stage/api-service');
    });

    it('throws when AWS_ENV is absent (fail closed, not a working-looking default)', () => {
      expect(() => vaultOpts.name({ env: {} })).to.throw(/AWS_ENV must be set/);
    });
  });
});
