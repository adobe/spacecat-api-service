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
 *
 * Force HTTP/1.1 (no keep-alive on Node ≥19) for every shared library's
 * @adobe/fetch context. Static ES imports hoist before code, and mocha CLI
 * --require this file before package.json `mocha.require` runs, so this is
 * the earliest point in process startup where we can set the env var before
 * any module-level fetch context is constructed. Subsequent imports must be
 * dynamic so they evaluate AFTER this line.
 */
process.env.HELIX_FETCH_FORCE_HTTP1 = '1';

const { initAuth, createAllTokens } = await import('../shared/auth.js');
const { buildEnv } = await import('../env.js');
const { startServer, stopServer } = await import('../server.js');
const { createHttpClient } = await import('../shared/http-client.js');
const { startPostgres, stopPostgres } = await import('./setup.js');

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
  },
};
