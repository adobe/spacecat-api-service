/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/**
 * Mocha Root Hook Plugin for the PostgreSQL (v3) integration tests.
 *
 * Usage:
 *   npx mocha --require test/it/postgres/harness.js test/it/postgres/*.test.js
 *
 * Starts Docker Compose (Postgres + PostgREST) and the dev server once
 * before all test files, and tears both down after all test files complete.
 */

// DIAGNOSTIC: import why-is-node-running FIRST so its async_hooks listener is
// active before any other module creates a handle. Lazy-importing it later
// means it misses everything created before its import — which is why
// previous diagnostic runs only ever attributed handles to our own console.log.
import wirn from 'why-is-node-running';

import { initAuth, createAllTokens } from '../shared/auth.js';
import { buildEnv } from '../env.js';
import { startServer, stopServer } from '../server.js';
import { createHttpClient } from '../shared/http-client.js';
import { startPostgres, stopPostgres } from './setup.js';

/** Shared state populated during beforeAll, consumed by test files. */
export const ctx = {};

// Extended timeout for the harness hooks: docker compose pull + container startup
// + dbmate migrations + PostgREST readiness can routinely exceed mocha's default
// 2s hook timeout (and the prior 30s ceiling that caused IT failures on heavier
// data-service image versions). 180s gives enough headroom on cold CI runs without
// masking real bugs.
const HARNESS_HOOK_TIMEOUT_MS = 180_000;

export const mochaHooks = {
  async beforeAll() {
    this.timeout(HARNESS_HOOK_TIMEOUT_MS);

    const { publicKeyB64 } = await initAuth();
    const tokens = await createAllTokens();

    await startPostgres();

    const env = buildEnv(publicKeyB64);
    const baseUrl = await startServer(env);

    ctx.httpClient = createHttpClient(baseUrl, tokens);
    ctx.baseUrl = baseUrl;
    ctx.tokens = tokens;
  },

  async afterAll() {
    this.timeout(HARNESS_HOOK_TIMEOUT_MS);
    await stopServer();
    await stopPostgres();

    // DIAGNOSTIC (do not merge): identify the intermittent handle that
    // sometimes keeps mocha from exiting after IT teardown and causes the
    // ci/it-postgres job to hit the 15-min step timeout. Dump active handles
    // immediately, then every 5s, force-exit at 60s. Also list child-process
    // tree state so we can tell whether the hang is in Node (unclosed handle)
    // or outside Node (orphaned helper / npm exec wrapper).
    const dump = (label) => {
      console.log(`\n=== handle dump [${label}] ===`);
      const handles = process.getActiveResourcesInfo
        ? process.getActiveResourcesInfo()
        : [];
      console.log('process.getActiveResourcesInfo():', JSON.stringify(handles));
      try {
        wirn();
      } catch (err) {
        console.error('wirn failed:', err);
      }
      // Extra context for diagnosing PipeWrap handles (stdio).
      /* eslint-disable no-underscore-dangle */
      const refed = (s) => !!s._handle?.hasRef?.();
      const stdioInfo = {
        stdin: {
          isTTY: process.stdin.isTTY,
          readable: process.stdin.readable,
          refed: refed(process.stdin),
        },
        stdout: {
          isTTY: process.stdout.isTTY,
          writable: process.stdout.writable,
          refed: refed(process.stdout),
        },
        stderr: {
          isTTY: process.stderr.isTTY,
          writable: process.stderr.writable,
          refed: refed(process.stderr),
        },
      };
      /* eslint-enable no-underscore-dangle */
      console.log('stdio info:', JSON.stringify(stdioInfo));
      console.log(`=== end dump [${label}] ===`);
    };

    // Snapshot child processes (Linux only — CI is ubuntu-latest).
    try {
      const { execSync } = await import('child_process');
      const psOut = execSync('ps -eo pid,ppid,stat,comm,args --no-headers 2>/dev/null | head -200', { encoding: 'utf8' });
      console.log('\n=== ps snapshot (post-teardown) ===');
      console.log(psOut);
      console.log('=== end ps snapshot ===');
    } catch (err) {
      console.error('ps snapshot failed:', err.message);
    }

    dump('t=0 immediately after teardown');

    let elapsed = 0;
    const interval = setInterval(() => {
      elapsed += 5;
      dump(`t=${elapsed}s`);
      if (elapsed >= 60) {
        clearInterval(interval);
        console.log('=== diagnostic timeout reached — force-exiting ===');
        process.exit(0);
      }
    }, 5000);
    interval.unref();
  },
};
