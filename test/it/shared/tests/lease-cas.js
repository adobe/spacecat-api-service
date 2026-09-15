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

import { expect } from 'chai';
import {
  claimJobLease, newLeaseToken, clearJobLease,
} from '../../../../src/support/serenity/job-lease.js';
import { LEASE_CAS_JOB_ID } from '../../postgres/seed-data/async-jobs.js';

/**
 * Integration tests for the async-job anti-replay lease (Gap 4 — a SECURITY
 * control). Unlike the sibling suites these do NOT drive the HTTP API: the lease
 * is an internal control invoked by the serenity job runner, and the property
 * under test is the DB-level compare-and-set itself. So these exercise the REAL
 * `claimJobLease` against the REAL dockerized Postgres + PostgREST — proving the
 * conditional `UPDATE ... WHERE status='IN_PROGRESS' AND (lease is free)` actually
 * lets exactly one of two concurrent SQS deliveries win, rather than trusting the
 * unit test's chainable stub to have modelled PostgREST's behaviour faithfully.
 *
 * The runner (src/serenity-prompt-classification/index.js) turns a claim into:
 *   - won === true  → this delivery processes (rotates the promise token, writes Semrush)
 *   - won === false → "lease held by another delivery", the duplicate is DROPPED (return ok)
 *   - throw         → fail closed, leave the message for SQS to redeliver
 * so the assertions below map directly onto those three outcomes.
 *
 * @param {() => import('@supabase/postgrest-js').PostgrestClient} getClient
 *   Returns a PostgREST client (writer JWT) bound to the harness — the same client
 *   shape the app injects at `context.dataAccess.services.postgrestClient`.
 * @param {() => import('@supabase/postgrest-js').PostgrestClient} getBadSchemaClient
 *   Returns a client pointed at a schema PostgREST does not expose, so a claim query
 *   returns a real PostgREST error (drives the fail-closed path).
 * @param {() => Promise<void>} resetData - Re-seeds the DB (restores the lease-free job).
 */
export default function leaseCasTests(getClient, getBadSchemaClient, resetData) {
  const JOB_ID = LEASE_CAS_JOB_ID;

  const ctxFor = (client) => ({
    dataAccess: { services: { postgrestClient: client } },
    log: { info() {}, warn() {}, error() {} },
  });

  const claim = (client, job, opts) => claimJobLease(ctxFor(client), job, opts);

  // A minimal AsyncJob-shaped stub: the lease functions only ever touch these.
  const makeJob = (id, metadata) => {
    let meta = { ...metadata };
    return {
      getId: () => id,
      getMetadata: () => meta,
      setMetadata: (m) => { meta = m; },
    };
  };

  // Loads the row's CURRENT metadata straight from the DB, so each stub mirrors a
  // fresh delivery that just re-loaded the job (as the runner does per message).
  const loadJob = async (client) => {
    const { data, error } = await client
      .from('async_jobs')
      .select('metadata')
      .eq('id', JOB_ID);
    expect(error, error && error.message).to.equal(null);
    expect(data).to.have.lengthOf(1);
    return makeJob(JOB_ID, data[0].metadata ?? {});
  };

  // The lease object as persisted on the row (or undefined if none).
  const readPersistedLease = async (client) => {
    const { data, error } = await client
      .from('async_jobs')
      .select('metadata')
      .eq('id', JOB_ID);
    expect(error, error && error.message).to.equal(null);
    expect(data).to.have.lengthOf(1);
    return data[0].metadata?.lease;
  };

  describe('async-job lease CAS (anti-replay, real Postgres)', () => {
    beforeEach(() => resetData());

    it('two concurrent claims on the same job: exactly one wins the CAS', async () => {
      const client = getClient();
      // Both deliveries loaded the job BEFORE either wrote — the seeded metadata
      // carries no lease, so nothing in-memory distinguishes them. Only the DB
      // row lock + re-evaluated guard can pick a single winner.
      const jobA = await loadJob(client);
      const jobB = await loadJob(client);
      const tokenA = newLeaseToken();
      const tokenB = newLeaseToken();
      expect(tokenA).to.not.equal(tokenB);

      const [wonA, wonB] = await Promise.all([
        claim(client, jobA, { leaseToken: tokenA }),
        claim(client, jobB, { leaseToken: tokenB }),
      ]);

      // Exactly one true — the security property. The loser is `false` (a dropped
      // duplicate), never a throw.
      expect([wonA, wonB].filter(Boolean)).to.have.lengthOf(1);

      // The winning delivery's token is what's persisted; the loser did NOT
      // overwrite it (last-writer-wins would be the vulnerability this guards).
      const winnerToken = wonA ? tokenA : tokenB;
      const persisted = await readPersistedLease(client);
      expect(persisted).to.be.an('object');
      expect(persisted.token).to.equal(winnerToken);
      expect(persisted.expiresAt).to.be.a('string');
    });

    it('a second claim while the lease is live loses (0 rows) and does not overwrite the holder', async () => {
      const client = getClient();
      const firstToken = newLeaseToken();
      const wonFirst = await claim(client, await loadJob(client), { leaseToken: firstToken });
      expect(wonFirst).to.equal(true);

      // A duplicate delivery now re-loads (sees the live lease) and tries to claim.
      const secondToken = newLeaseToken();
      const wonSecond = await claim(client, await loadJob(client), { leaseToken: secondToken });
      // Held, non-expired lease → CAS matches 0 rows → dropped, not thrown.
      expect(wonSecond).to.equal(false);

      // The holder's token is intact — the loser wrote nothing.
      const persisted = await readPersistedLease(client);
      expect(persisted.token).to.equal(firstToken);
    });

    it('a claim-query error fails closed (throws) rather than silently succeeding', async () => {
      // A real PostgREST error (the client targets a schema PostgREST does not
      // expose): claimJobLease must propagate it so the runner leaves the message
      // for SQS to redeliver — never treat an errored claim as "not held, proceed".
      const badCtx = ctxFor(getBadSchemaClient());
      const job = makeJob(JOB_ID, {});
      let threw = false;
      try {
        await claimJobLease(badCtx, job, { leaseToken: newLeaseToken() });
      } catch (e) {
        threw = true;
        expect(e.message).to.match(/lease claim query failed/);
      }
      expect(threw, 'claimJobLease must throw on a claim-query error').to.equal(true);

      // Fail-closed means it did NOT stamp a lease on the (untouched) job either.
      expect(job.getMetadata().lease).to.equal(undefined);
    });

    it('once the lease TTL has elapsed, a redelivery can re-claim (resume)', async () => {
      const client = getClient();
      // First delivery claims with an ALREADY-expired window (now far in the past,
      // short ttl) — mimics a holder that has since died.
      const deadToken = newLeaseToken();
      const past = Date.now() - (60 * 60 * 1000); // 1h ago
      const wonDead = await claimJobLease(
        ctxFor(client),
        await loadJob(client),
        { leaseToken: deadToken, now: past, ttlMs: 1000 },
      );
      expect(wonDead).to.equal(true);

      // The redelivery, evaluated at real `now`, sees the expired lease and the
      // still-IN_PROGRESS job, so the CAS's `expiresAt < now` disjunct matches.
      const resumeToken = newLeaseToken();
      const wonResume = await claimJobLease(
        ctxFor(client),
        await loadJob(client),
        { leaseToken: resumeToken },
      );
      expect(wonResume).to.equal(true);

      const persisted = await readPersistedLease(client);
      expect(persisted.token).to.equal(resumeToken);
    });

    it('after an explicit lease clear (terminal release), a subsequent delivery can claim', async () => {
      const client = getClient();
      const firstToken = newLeaseToken();
      const wonFirst = await claim(client, await loadJob(client), { leaseToken: firstToken });
      expect(wonFirst).to.equal(true);

      // The runner scrubs the lease on a terminal/release path (clearJobLease) and
      // persists it via job.save(). Reproduce that persisted release directly.
      const held = await loadJob(client);
      clearJobLease(held);
      const { error: clearError } = await client
        .from('async_jobs')
        .update({ metadata: held.getMetadata() })
        .eq('id', JOB_ID)
        .select('id');
      expect(clearError, clearError && clearError.message).to.equal(null);
      expect(await readPersistedLease(client)).to.equal(undefined);

      // A fresh delivery can now claim the freed job.
      const nextToken = newLeaseToken();
      const wonNext = await claim(client, await loadJob(client), { leaseToken: nextToken });
      expect(wonNext).to.equal(true);
      expect((await readPersistedLease(client)).token).to.equal(nextToken);
    });
  });
}
