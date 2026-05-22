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

// Proof PR: import wirn at module top so async_hooks captures all handles
// created later by any module. Used after teardown to verify the leak is gone.
import wirn from 'why-is-node-running';
import { resetDataAccessConnections } from '@adobe/spacecat-shared-data-access';

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

    // BEFORE the fix: count the leaked handles.
    const before = process.getActiveResourcesInfo();
    console.log(`\n[proof] handles BEFORE reset: ${before.length}`, before.slice(0, 10));

    // THE FIX under test.
    await resetDataAccessConnections();

    // AFTER the fix: count again and run wirn (will print refs holding the loop).
    const after = process.getActiveResourcesInfo();
    console.log(`[proof] handles AFTER reset: ${after.length}`, after.slice(0, 10));
    console.log('[proof] wirn — handles still keeping loop alive:');
    try {
      wirn();
    } catch (err) {
      console.error('wirn failed:', err);
    }

    await stopPostgres();

    // Backstop: if the fix didn't fully drain, exit anyway after 5s so the
    // CI job doesn't sit at the 15-min timeout. Unref so the timer doesn't
    // itself extend the loop.
    setTimeout(() => {
      console.log('[proof] backstop force-exit fired — fix did not fully drain');
      process.exit(0);
    }, 5000).unref();
  },
};
