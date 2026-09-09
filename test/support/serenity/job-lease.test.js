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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import {
  claimJobLease, renewJobLease, clearJobLease, newLeaseToken,
} from '../../../src/support/serenity/job-lease.js';

use(chaiAsPromised);
use(sinonChai);

/**
 * A chainable PostgREST fake that records the filter chain and resolves the
 * builder to a configurable `{ data, error }`.
 */
function makeQuery(result) {
  const calls = {
    filters: [], update: null, table: null, select: null,
  };
  const builder = {
    update(u) {
      calls.update = u;
      return builder;
    },
    eq(col, val) {
      calls.filters.push(['eq', col, val]);
      return builder;
    },
    or(expr) {
      calls.filters.push(['or', expr]);
      return builder;
    },
    select(cols) {
      calls.select = cols;
      return Promise.resolve(result);
    },
  };
  const client = {
    from(table) {
      calls.table = table;
      return builder;
    },
  };
  return { client, calls };
}

function makeJob(metadata = {}) {
  let meta = { ...metadata };
  return {
    getId: () => 'job-1',
    getMetadata: () => meta,
    setMetadata: (m) => { meta = m; },
  };
}

function makeContext(client) {
  return {
    dataAccess: { services: { postgrestClient: client } },
    log: { warn: sinon.stub(), info: sinon.stub() },
  };
}

describe('job-lease', () => {
  it('newLeaseToken mints distinct tokens', () => {
    expect(newLeaseToken()).to.be.a('string').with.length.greaterThan(10);
    expect(newLeaseToken()).to.not.equal(newLeaseToken());
  });

  describe('claimJobLease', () => {
    it('wins when the conditional update returns exactly one row, and stamps the lease on the job', async () => {
      const { client, calls } = makeQuery({ data: [{ id: 'job-1' }], error: null });
      const job = makeJob({ jobType: 'x' });

      const won = await claimJobLease(makeContext(client), job, { leaseToken: 'lt', now: 1_000 });

      expect(won).to.equal(true);
      expect(calls.table).to.equal('async_jobs');
      // The CAS guard: id + status=IN_PROGRESS + free-lease OR-expression.
      expect(calls.filters).to.deep.include(['eq', 'id', 'job-1']);
      expect(calls.filters).to.deep.include(['eq', 'status', 'IN_PROGRESS']);
      expect(calls.filters.some(([op, expr]) => op === 'or' && /metadata->lease/.test(expr))).to.equal(true);
      // Lease reflected onto the in-memory job.
      expect(job.getMetadata().lease.token).to.equal('lt');
    });

    it('loses when the update returns no rows (another delivery holds the lease)', async () => {
      const { client } = makeQuery({ data: [], error: null });
      const job = makeJob();
      const won = await claimJobLease(makeContext(client), job, { leaseToken: 'lt' });
      expect(won).to.equal(false);
      expect(job.getMetadata().lease).to.equal(undefined);
    });

    it('throws (fail-closed) when there is no PostgREST client', async () => {
      const job = makeJob();
      await expect(claimJobLease({ dataAccess: { services: {} }, log: {} }, job, { leaseToken: 'lt' }))
        .to.be.rejectedWith(/PostgREST client unavailable/);
    });

    it('throws when the claim query errors (caller must not process unguarded)', async () => {
      const { client } = makeQuery({ data: null, error: { message: 'boom' } });
      const job = makeJob();
      await expect(claimJobLease(makeContext(client), job, { leaseToken: 'lt' }))
        .to.be.rejectedWith(/lease claim query failed/);
    });
  });

  describe('renewJobLease', () => {
    it('renews on the matching lease token', async () => {
      const { client, calls } = makeQuery({ data: [{ id: 'job-1' }], error: null });
      const job = makeJob({ lease: { token: 'lt', expiresAt: 'old' } });
      const ok = await renewJobLease(makeContext(client), job, { leaseToken: 'lt', now: 5_000 });
      expect(ok).to.equal(true);
      expect(calls.filters).to.deep.include(['eq', 'metadata->lease->>token', 'lt']);
    });

    it('is best-effort: returns false and swallows a query error', async () => {
      const { client } = makeQuery({ data: null, error: { message: 'x' } });
      const job = makeJob({ lease: { token: 'lt' } });
      expect(await renewJobLease(makeContext(client), job, { leaseToken: 'lt' })).to.equal(false);
    });

    it('returns false with no client', async () => {
      const job = makeJob();
      expect(await renewJobLease({ dataAccess: {} }, job, { leaseToken: 'lt' })).to.equal(false);
    });
  });

  describe('clearJobLease', () => {
    it('removes the lease from in-memory metadata, keeping everything else', () => {
      const job = makeJob({ jobType: 'x', lease: { token: 'lt' }, foo: 'bar' });
      clearJobLease(job);
      expect(job.getMetadata()).to.deep.equal({ jobType: 'x', foo: 'bar' });
    });
  });
});
