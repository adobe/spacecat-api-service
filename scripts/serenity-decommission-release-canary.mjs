#!/usr/bin/env node
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

/* eslint-disable no-console */

/**
 * Live-gateway canary for LLMO-6189 — proves `releaseFullAllocation` actually returns a
 * sub-workspace's AI allocation surplus to the parent pool by lowering the child to a small
 * non-zero floor, WITHOUT ever deleting the workspace (production never deletes a sub-workspace —
 * Rainer, 2026-07-16 PR review; serenity-docs#22 §4: "the cheapest fix is a one-shot operator
 * script issuing a lowering transfer to a non-zero floor").
 *
 * WHY THIS CAN'T RUN IN CI OR BE RUN BY the implementing agent: every Semrush call needs a live
 * IMS bearer token and a real workspace the token is admin on. A human with dev credentials must
 * run this manually (mirrors canary.mjs / fix-canary.mjs / serenity-metered-405-canary.mjs).
 *
 * Usage:
 *   IMS_TOKEN=$(mysticat auth token --ims) MASTER_WS=<a workspace you are admin on> \
 *   node scripts/serenity-decommission-release-canary.mjs
 *
 * MUTATING: creates one throwaway `decommission-canary-*` child under MASTER_WS, carves it a small
 * allocation, then exercises `releaseFullAllocation`. Cleans up by deleting the child at the end
 * (test/smoke-only use of `deleteWorkspace` — the thing under test never deletes it itself).
 *
 * What it proves:
 *   1. releaseFullAllocation lowers the child's AI allocation to the (default) non-zero floor
 *      { projects:1, prompts:1 } — NOT to zero (a proven silent no-op) and NOT via deletion.
 *   2. The workspace still exists afterward (getWorkspaceStatus succeeds) — decommission never
 *      deletes it.
 *   3. The MASTER pool's own total reflects exactly (carved - floor) coming back — the floor
 *      amount stays reserved on the child by design until an actual decommission/delete (never
 *      done by this fix; only by this canary's own throwaway test cleanup) reclaims it too.
 */

import { env, exit } from 'node:process';
import { createSerenityTransport } from '../src/support/serenity/rest-transport.js';
import {
  deleteAllProjects, releaseFullAllocation, DEFAULT_RELEASE_FLOOR,
} from '../src/support/serenity/workspace-lifecycle.js';

const need = (name) => {
  const v = env[name];
  if (!v) {
    console.error(`\n  Missing required env ${name}. See the header.\n`);
    exit(2);
  }
  return v;
};

const IMS_TOKEN = need('IMS_TOKEN');
const MASTER_WS = need('MASTER_WS');
const PROJECTS = env.SEMRUSH_PROJECTS_BASE_URL || 'https://adobe-hackathon.semrush.com';
const USERS = env.SEMRUSH_USERS_BASE_URL || PROJECTS;

const log = {
  info: (...a) => console.log('   ·', ...a),
  warn: (...a) => console.log('   ⚠', ...a),
  error: (...a) => console.log('   ✗', ...a),
};

const poll = {
  attempts: 25,
  intervalMs: 1000,
  sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }),
};

const transport = createSerenityTransport({
  env: {
    SEMRUSH_PROJECTS_BASE_URL: PROJECTS,
    SEMRUSH_USERS_BASE_URL: USERS,
    // Test/smoke-cleanup-only opt-in (see rest-transport.js's deleteWorkspace doc) — used here
    // ONLY for this canary's own teardown, never by releaseFullAllocation itself.
    SERENITY_ALLOW_WORKSPACE_DELETE: 'true',
  },
  imsToken: IMS_TOKEN,
});

async function settle(id) {
  for (let i = 0; i < poll.attempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const s = await transport.getWorkspaceStatus(id);
    if ((s?.status ?? s) === 'created') {
      return true;
    }
    // eslint-disable-next-line no-await-in-loop
    await poll.sleep(poll.intervalMs);
  }
  return false;
}

async function readTotals(id) {
  const r = await transport.getWorkspaceResources(id);
  return r?.product_resources?.ai?.resources;
}

// Master-pool restoration reconciles asynchronously and can lag noticeably longer than a child
// workspace's own settle time (live-verified) — give it a longer window than `poll.attempts`.
const RECONCILE_ATTEMPTS = 90;
const RECONCILE_INTERVAL_MS = 2000;

async function pollUntil(fn, attempts = poll.attempts, intervalMs = poll.intervalMs) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    last = await fn();
    if (last) {
      return last;
    }
    // eslint-disable-next-line no-await-in-loop
    await poll.sleep(intervalMs);
  }
  return last;
}

let childId = null;
let pass = true;
const check = (ok, msg) => {
  console.log(`   ${ok ? '✅' : '❌'} ${msg}`);
  if (!ok) {
    pass = false;
  }
};

(async () => {
  console.log(`Decommission-release canary — master=${MASTER_WS}  gateway=${USERS}`);
  try {
    const masterBefore = await readTotals(MASTER_WS);
    console.log(`\n[read] master prompts total (before) = ${masterBefore?.prompts?.total}`);

    console.log('\n[create] throwaway child at { projects:5, prompts:800 } (simulates a legacy over-carve)...');
    const created = await transport.createSubworkspace(
      MASTER_WS,
      `decommission-canary-${Date.now()}`,
      { ai: { projects: 5, prompts: 800 } },
    );
    childId = created?.id;
    if (!childId) {
      throw new Error('create returned no id');
    }
    console.log(`   child ${childId} (status ${created.status})`);
    await settle(childId);

    console.log('\n[release] deleteAllProjects + releaseFullAllocation (default floor)...');
    const emptied = await deleteAllProjects(transport, childId);
    console.log(`   deleteAllProjects: ${emptied} project(s) attempted`);
    const result = await releaseFullAllocation(transport, childId, MASTER_WS, log);
    console.log(`   → ${JSON.stringify(result)}`);
    check(result.released === true, 'released === true');
    check(result.reason === 'lowered-to-floor', "reason === 'lowered-to-floor'");

    console.log('   confirming the workspace still EXISTS (never deleted)...');
    const stillExists = await transport.getWorkspaceStatus(childId)
      .then(() => true).catch(() => false);
    check(stillExists, 'workspace still exists (was NOT deleted)');

    console.log('   confirming the child settled at the non-zero floor...');
    const childAfter = await pollUntil(async () => {
      const totals = await readTotals(childId);
      const atFloor = totals?.prompts?.total === DEFAULT_RELEASE_FLOOR.prompts
        && totals?.projects?.total === DEFAULT_RELEASE_FLOOR.projects;
      return atFloor ? totals : null;
    });
    check(
      childAfter?.prompts?.total === DEFAULT_RELEASE_FLOOR.prompts
        && childAfter?.projects?.total === DEFAULT_RELEASE_FLOOR.projects,
      `child lowered to the floor (${JSON.stringify(DEFAULT_RELEASE_FLOOR)})`,
    );

    // The floor release only ever returns (carved - floor) — the floor amount stays reserved on
    // the child by design (immediate headroom for its next reactivation) until this canary's own
    // test-only cleanup below deletes the whole throwaway child, which reclaims that last bit too.
    // So AT THIS POINT master is expected to be short by exactly floor.prompts, not fully restored.
    const expectedAfterRelease = (masterBefore?.prompts?.total ?? 0)
      - DEFAULT_RELEASE_FLOOR.prompts;
    console.log(`   confirming the master pool total reflects the release, short by exactly the floor (${DEFAULT_RELEASE_FLOOR.prompts}) until this canary's own cleanup delete reclaims that last bit (async reconciliation can take a while)...`);
    const masterAfter = await pollUntil(async () => {
      const totals = await readTotals(MASTER_WS);
      return totals?.prompts?.total === expectedAfterRelease ? totals : null;
    }, RECONCILE_ATTEMPTS, RECONCILE_INTERVAL_MS);
    console.log(`\n[read] master prompts total (after release, before cleanup) = ${masterAfter?.prompts?.total} (expect ${expectedAfterRelease} = before(${masterBefore?.prompts?.total}) - floor(${DEFAULT_RELEASE_FLOOR.prompts}))`);
    check(masterAfter?.prompts?.total === expectedAfterRelease, 'master pool total reflects the released surplus (short only by the floor)');

    console.log(`\n${pass ? '✅ FIX VERIFIED' : '❌ FIX NOT VERIFIED'} — releaseFullAllocation lowers to a non-zero floor, returns the surplus, and never deletes the workspace.`);
  } catch (e) {
    const status = e?.status ? `HTTP ${e.status}` : '';
    console.log(`\n✗ FAILED ${status}: ${e?.message}`);
    if (e?.status === 403) {
      console.log('   → 403 = your IMS token is not admin on this workspace (writes blocked).');
    }
    pass = false;
  } finally {
    if (childId) {
      console.log(`\nCleaning up throwaway child ${childId} (test-only delete)...`);
      try {
        await transport.deleteWorkspace(childId);
        console.log('  deleted ✔');
      } catch (e) {
        console.log(`  cleanup failed (${e?.status || ''} ${e?.message}) — reap ${childId} manually`);
      }
    }
    exit(pass ? 0 : 1);
  }
})();
