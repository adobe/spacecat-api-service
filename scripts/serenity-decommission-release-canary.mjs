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
 * Live-gateway canary for LLMO-6189 — proves `releaseFullAllocation` actually reclaims a
 * sub-workspace's AI allocation to the parent pool via delete, and that the pre-fix behavior
 * (a to-zero transfer reporting false success) stays closed off when `allowDelete` is false.
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
 * allocation, then exercises both `releaseFullAllocation` branches against it. Cleans up by
 * deleting the child at the end regardless of which branch ran (idempotent if already deleted).
 *
 * What it proves:
 *   1. allowDelete=false: releaseFullAllocation returns { released:false, reason:'requires-
 *      decommission' } and does NOT touch the workspace (still exists, same total) — the FIXED
 *      "never lie about success" contract, replacing the old silent-no-op-reported-as-success bug.
 *   2. allowDelete=true: deleteAllProjects + releaseFullAllocation return { released:true,
 *      reason:'deleted' }, the workspace is genuinely gone afterward (getWorkspaceStatus 403s),
 *      and the MASTER pool's own total is restored by the released amount.
 */

import { env, exit } from 'node:process';
import { createSerenityTransport } from '../src/support/serenity/rest-transport.js';
import {
  deleteAllProjects, releaseFullAllocation,
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

async function poolTotal(id, dim) {
  const r = await transport.getWorkspaceResources(id);
  return r?.product_resources?.ai?.resources?.[dim]?.total;
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
    const masterBefore = await poolTotal(MASTER_WS, 'prompts');
    console.log(`\n[read] master prompts total (before) = ${masterBefore}`);

    console.log('\n[create] throwaway child at { projects:1, prompts:100 }...');
    const created = await transport.createSubworkspace(
      MASTER_WS,
      `decommission-canary-${Date.now()}`,
      { ai: { projects: 1, prompts: 100 } },
    );
    childId = created?.id;
    if (!childId) {
      throw new Error('create returned no id');
    }
    console.log(`   child ${childId} (status ${created.status})`);
    await settle(childId);

    // --- Case 1: allowDelete=false must refuse to reclaim and must NOT lie about success ---
    console.log('\n[case 1] releaseFullAllocation with allowDelete=false (today\'s default)...');
    const emptied1 = await deleteAllProjects(transport, childId);
    console.log(`   deleteAllProjects: ${emptied1} project(s) attempted`);
    const result1 = await releaseFullAllocation(
      transport,
      childId,
      MASTER_WS,
      log,
      { allowDelete: false },
    );
    console.log(`   → ${JSON.stringify(result1)}`);
    check(result1.released === false, 'released === false');
    check(result1.reason === 'requires-decommission', "reason === 'requires-decommission'");
    const stillExists = await transport.getWorkspaceStatus(childId)
      .then(() => true).catch(() => false);
    check(stillExists, 'workspace still exists (was NOT deleted)');

    // --- Case 2: allowDelete=true must genuinely reclaim via delete ---
    console.log('\n[case 2] releaseFullAllocation with allowDelete=true (explicit opt-in)...');
    const result2 = await releaseFullAllocation(
      transport,
      childId,
      MASTER_WS,
      log,
      { allowDelete: true },
    );
    console.log(`   → ${JSON.stringify(result2)}`);
    check(result2.released === true, 'released === true');
    check(result2.reason === 'deleted', "reason === 'deleted'");

    console.log('   confirming the workspace is genuinely gone...');
    const goneAfter = await transport.getWorkspaceStatus(childId)
      .then(() => false)
      .catch((e) => e?.status === 403 || e?.status === 404);
    check(goneAfter, 'getWorkspaceStatus now fails (403/404) — workspace genuinely deleted');

    const masterAfter = await poolTotal(MASTER_WS, 'prompts');
    console.log(`\n[read] master prompts total (after) = ${masterAfter} (expect back to ${masterBefore})`);
    check(masterAfter === masterBefore, 'master pool total restored to pre-carve value');

    childId = null; // already deleted by case 2 — skip the cleanup block below

    console.log(`\n${pass ? '✅ FIX VERIFIED' : '❌ FIX NOT VERIFIED'} — both releaseFullAllocation branches behave as designed against the live gateway.`);
  } catch (e) {
    const status = e?.status ? `HTTP ${e.status}` : '';
    console.log(`\n✗ FAILED ${status}: ${e?.message}`);
    if (e?.status === 403) {
      console.log('   → 403 = your IMS token is not admin on this workspace (writes blocked).');
    }
    pass = false;
  } finally {
    if (childId) {
      console.log(`\nCleaning up leftover child ${childId}...`);
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
