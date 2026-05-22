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
 */

// PROOF PR — option (c) experiment: set HELIX_FETCH_FORCE_HTTP1=1 BEFORE any
// module-level @adobe/fetch context is created, then dynamic-import everything
// else. ES static imports hoist before code, so the env var would otherwise be
// set too late. Each shared library reads the env at its own module-load time
// and chooses h1() (no keep-alive on Node ≥19) vs h2() (keep-alive pool).
console.log('[proof] HELIX_FETCH_FORCE_HTTP1 was:', JSON.stringify(process.env.HELIX_FETCH_FORCE_HTTP1));
process.env.HELIX_FETCH_FORCE_HTTP1 = '1';
console.log('[proof] HELIX_FETCH_FORCE_HTTP1 now:', JSON.stringify(process.env.HELIX_FETCH_FORCE_HTTP1));

// Import wirn first so its async_hooks listener captures every later handle.
const wirn = (await import('why-is-node-running')).default;

const { initAuth, createAllTokens } = await import('../shared/auth.js');
const { buildEnv } = await import('../env.js');
const { startServer, stopServer } = await import('../server.js');
const { createHttpClient } = await import('../shared/http-client.js');
const { startPostgres, stopPostgres } = await import('./setup.js');

/** Shared state populated during beforeAll, consumed by test files. */
export const ctx = {};

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

    const before = process.getActiveResourcesInfo();
    console.log(`\n[proof] handles BEFORE stopPostgres: ${before.length}`, before.slice(0, 12));

    await stopPostgres();

    const after = process.getActiveResourcesInfo();
    console.log(`[proof] handles AFTER stopPostgres: ${after.length}`, after.slice(0, 12));
    console.log('[proof] wirn — handles still keeping loop alive:');
    try {
      wirn();
    } catch (err) {
      console.error('wirn failed:', err);
    }

    // 5s backstop so CI doesn't sit at 15-min timeout if loop is still pinned.
    setTimeout(() => {
      console.log('[proof] backstop force-exit fired — loop was still pinned');
      process.exit(0);
    }, 5000).unref();
  },
};
