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

import { DevelopmentServer } from '@adobe/helix-universal-devserver';
import { main } from '../../src/index.js';

const PORT = process.env.IT_SERVER_PORT || '3002';

let devServer;

/**
 * Starts the dev server with the given environment variables.
 * Uses deterministic startup (no nodemon) for CI stability.
 *
 * @param {object} envVars - Environment variables to inject
 * @returns {Promise<string>} The base URL of the running server
 */
export async function startServer(envVars) {
  Object.assign(process.env, envVars);

  process.env.HLX_DEV_SERVER_HOST = `localhost:${PORT}`;
  process.env.HLX_DEV_SERVER_SCHEME = 'http';

  devServer = new DevelopmentServer(main);
  await devServer
    .withPort(PORT)
    .withHeader('x-forwarded-host', '')
    .init();
  await devServer.start();

  return `http://localhost:${PORT}`;
}

/**
 * Stops the dev server.
 */
export async function stopServer() {
  if (devServer) {
    await devServer.stop();
    devServer = null;
  }
}
