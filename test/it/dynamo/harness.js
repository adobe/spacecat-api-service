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
 * Mocha Root Hook Plugin for the DynamoDB (v2) integration tests.
 *
 * Usage:
 *   npx mocha --require test/it/dynamo/harness.js test/it/dynamo/*.test.js
 *
 * Starts DynamoDB Local and the dev server once before all test files,
 * and tears both down after all test files complete.
 */

import { initAuth, createAllTokens } from '../shared/auth.js';
import { buildEnv } from '../env.js';
import { startServer, stopServer } from '../server.js';
import { createHttpClient } from '../shared/http-client.js';
import { startDynamo, stopDynamo } from './setup.js';

/** Shared state populated during beforeAll, consumed by test files. */
export const ctx = {};

export const mochaHooks = {
  async beforeAll() {
    // Suppress ElectroDB debug logs (hundreds of thousands of lines per run).
    // The v2 data-access lib logs every DynamoDB operation via log.debug(),
    // and the helix dev server maps debug → console.debug with no level filter.
    console.debug = () => {};

    const { publicKeyB64 } = await initAuth();
    const tokens = await createAllTokens();

    await startDynamo();

    const env = buildEnv('dynamo', publicKeyB64);
    const baseUrl = await startServer(env);

    ctx.httpClient = createHttpClient(baseUrl, tokens);
  },

  async afterAll() {
    await stopServer();
    await stopDynamo();
  },
};
