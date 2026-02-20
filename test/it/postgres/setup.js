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

/* eslint-disable no-await-in-loop, no-underscore-dangle, max-statements-per-line */
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = path.join(__dirname, 'docker-compose.yml');
const POSTGREST_PORT = process.env.IT_POSTGREST_PORT || '3300';
const POSTGREST_URL = `http://localhost:${POSTGREST_PORT}`;

/**
 * Polls the PostgREST admin endpoint until it responds.
 *
 * @param {number} maxAttempts - Maximum poll attempts
 * @param {number} intervalMs - Delay between attempts
 */
async function waitForPostgREST(maxAttempts = 60, intervalMs = 1000) {
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      const res = await fetch(`${POSTGREST_URL}/`);
      if (res.ok || res.status === 200) {
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }

  throw new Error(`PostgREST did not become ready within ${maxAttempts * intervalMs}ms`);
}

/**
 * Starts PostgreSQL + PostgREST via docker compose and waits for readiness.
 *
 * @returns {Promise<string>} The PostgREST base URL
 */
export async function startPostgres() {
  execSync(
    `docker compose -f "${COMPOSE_FILE}" up -d`,
    { stdio: 'inherit', timeout: 120_000 },
  );

  // Wait for PostgREST to become ready (migrations run first via command override)
  await waitForPostgREST();

  return POSTGREST_URL;
}

/**
 * Tears down docker compose services and removes volumes.
 */
export async function stopPostgres() {
  try {
    execSync(
      `docker compose -f "${COMPOSE_FILE}" down -v --remove-orphans`,
      { stdio: 'inherit', timeout: 30_000 },
    );
  } catch (err) {
    console.error('Warning: docker compose down failed:', err.message);
  }
}
