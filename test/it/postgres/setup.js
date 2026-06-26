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
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = path.join(__dirname, 'docker-compose.yml');
const REPO_ROOT = path.join(__dirname, '..', '..', '..');

/**
 * Reads the INSTALLED version of a dependency from its package.json. The mock
 * Docker image is published from the same package as the typed client, so the
 * mock tag must equal the client version we actually ship — otherwise the IT
 * runs against a different contract than production. Read via fs (not require)
 * because the client packages restrict the `./package.json` subpath in exports.
 *
 * @param {string} pkg - npm package name
 * @returns {string} the installed semver
 */
function installedVersion(pkg) {
  const pkgJson = path.join(REPO_ROOT, 'node_modules', pkg, 'package.json');
  // Let a missing package throw (ENOENT) — fail hard rather than fall back to a
  // hardcoded tag, which would silently test a different version than we ship.
  const { version } = JSON.parse(readFileSync(pkgJson, 'utf8'));
  if (!version || typeof version !== 'string') {
    throw new Error(`Could not resolve installed version of ${pkg} for the Semrush mock image tag`);
  }
  return version;
}
const POSTGREST_PORT = process.env.IT_POSTGREST_PORT || '3300';
const POSTGREST_URL = `http://localhost:${POSTGREST_PORT}`;
const MINIO_PORT = process.env.IT_MINIO_PORT || '9100';
const MINIO_HEALTH_URL = `http://localhost:${MINIO_PORT}/minio/health/live`;

// Semrush vendor mocks (serenity E2E). Self-signed HTTPS; the readiness probe
// and the reset helper both talk to the unauthenticated control routes, so they
// run with TLS verification disabled regardless of the dev server's setting.
const PE_MOCK_PORT = process.env.IT_PE_MOCK_PORT || '8443';
const UM_MOCK_PORT = process.env.IT_UM_MOCK_PORT || '8444';
const PE_MOCK_BASE = `https://localhost:${PE_MOCK_PORT}/enterprise/projects/api`;
const UM_MOCK_BASE = `https://localhost:${UM_MOCK_PORT}/enterprise/users/api`;
const MOCK_DUMP_PATHS = [`${PE_MOCK_BASE}/__dump`, `${UM_MOCK_BASE}/__dump`];
const MOCK_RESET_PATHS = [`${PE_MOCK_BASE}/__reset`, `${UM_MOCK_BASE}/__reset`];

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
 * Polls the MinIO health endpoint until it responds.
 *
 * @param {number} maxAttempts - Maximum poll attempts
 * @param {number} intervalMs - Delay between attempts
 */
async function waitForMinio(maxAttempts = 60, intervalMs = 500) {
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      const res = await fetch(MINIO_HEALTH_URL);
      if (res.ok) {
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }

  throw new Error(`MinIO did not become ready within ${maxAttempts * intervalMs}ms`);
}

/**
 * Polls both Semrush mock control endpoints until they respond over HTTPS.
 * Uses a per-request fetch with TLS verification disabled (self-signed cert).
 *
 * @param {number} maxAttempts - Maximum poll attempts
 * @param {number} intervalMs - Delay between attempts
 */
async function waitForSemrushMocks(maxAttempts = 60, intervalMs = 1000) {
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    for (let i = 0; i < maxAttempts; i += 1) {
      try {
        const results = await Promise.all(
          MOCK_DUMP_PATHS.map((url) => fetch(url).then((r) => r.ok).catch(() => false)),
        );
        if (results.every(Boolean)) {
          return;
        }
      } catch {
        // Not ready yet
      }
      await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
    }
    throw new Error(`Semrush mocks did not become ready within ${maxAttempts * intervalMs}ms`);
  } finally {
    if (prev === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  }
}

/**
 * Resets both Semrush mocks to their boot seed. Call between test cases that
 * mutate mock state (activate/create/delete) so each starts from a known store.
 */
export async function resetSemrushMocks() {
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    // Throw on a failed reset rather than swallow it: a silently-failed reset
    // would leave mutated mock state behind and produce flaky, order-dependent
    // tests (the mutating-lifecycle increment relies on this).
    await Promise.all(
      MOCK_RESET_PATHS.map(async (url) => {
        const res = await fetch(url, { method: 'POST' });
        if (!res.ok) {
          throw new Error(`Semrush mock reset failed (${res.status}) at ${url}`);
        }
      }),
    );
  } finally {
    if (prev === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  }
}

/**
 * Creates the MinIO bucket used by IT tests if it does not already exist.
 * MinIO is S3-compatible so `NoSuchBucket` errors are replaced by `HeadBucket 404`.
 */
async function ensureMinIoBucket() {
  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: `http://localhost:${MINIO_PORT}`,
    forcePathStyle: true,
    credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
  });
  const bucket = 'spacecat-it-test';
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

/**
 * Starts the full IT container stack via docker compose — PostgreSQL + PostgREST
 * (data-service), MinIO, and the Semrush Project Engine / User Manager mocks —
 * and waits for all of them to become ready.
 *
 * @returns {Promise<string>} The PostgREST base URL
 */
export async function startContainers() {
  // Pin each Semrush mock image to the version of the typed client we actually
  // depend on (the mock is published from that same package). Drift here would
  // silently test a different contract than production ships. A bumped client
  // whose mock image is not yet published makes the pull fail loudly — by design.
  process.env.SERENITY_PE_MOCK_TAG = installedVersion('@adobe/spacecat-shared-project-engine-client');
  process.env.SERENITY_UM_MOCK_TAG = installedVersion('@adobe/spacecat-shared-user-manager-client');

  execSync(
    `docker compose -f "${COMPOSE_FILE}" up -d`,
    { stdio: 'inherit', timeout: 120_000 },
  );

  // Wait for PostgREST, MinIO and the Semrush mocks to become ready in parallel
  await Promise.all([
    waitForPostgREST(),
    waitForMinio(),
    waitForSemrushMocks(),
  ]);

  await ensureMinIoBucket();

  return POSTGREST_URL;
}

/**
 * Tears down all IT containers (data-service, MinIO, Semrush mocks) and removes volumes.
 */
export async function stopContainers() {
  try {
    execSync(
      `docker compose -f "${COMPOSE_FILE}" down -v --remove-orphans`,
      { stdio: 'inherit', timeout: 30_000 },
    );
  } catch (err) {
    console.error('Warning: docker compose down failed:', err.message);
  }
}
