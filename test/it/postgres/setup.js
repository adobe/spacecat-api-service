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
  // TLS verification is disabled process-wide by startContainers (and again by
  // buildEnv) for this IT-only process, so the self-signed mock cert is trusted
  // here without per-call save/restore.
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      const results = await Promise.all(
        // Per-probe 5s AbortController: if a mock accepts the TCP connection but
        // hangs (Caddy up, Counterfact not yet bound), a bare fetch could block
        // for the platform TCP timeout and eat the whole poll budget. Cap each.
        MOCK_DUMP_PATHS.map((url) => fetch(url, { signal: AbortSignal.timeout(5000) })
          .then((r) => r.ok).catch(() => false)),
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
}

/**
 * Resets both Semrush mocks to their boot seed. Call between test cases that
 * mutate mock state (activate/create/delete) so each starts from a known store.
 */
export async function resetSemrushMocks() {
  // TLS verification is already off process-wide (startContainers + buildEnv ran
  // during harness startup, before any test calls this), so the self-signed mock
  // cert is trusted without a per-call save/restore.
  // Throw on a failed reset rather than swallow it: a silently-failed reset would
  // leave mutated mock state behind and produce flaky, order-dependent tests (the
  // mutating-lifecycle increment relies on this).
  await Promise.all(
    MOCK_RESET_PATHS.map(async (url) => {
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) {
        throw new Error(`Semrush mock reset failed (${res.status}) at ${url}`);
      }
    }),
  );
}

/**
 * Sets a workspace's finite AI resources on the User Manager mock via its `POST /__quota` control
 * route (makes it metered). Each dim is a bare `total` or `{ used, drafted, total }`.
 *
 * Retained control-route seam, deliberately still wired: the dynamic-allocation flag-ON IT that
 * used to consume this was removed with the allocator (SITES-49206), so no IT calls it today. It
 * stays exported — and threaded through `mockControls` in serenity.test.js — because the
 * spacecat-shared §10.5 metered-write change (and the §10 metered-405 canary) will re-meter a
 * sub-workspace through this same route; dropping it now would only have to be re-added there.
 * TLS verification is already off process-wide.
 *
 * @param {string} workspaceId - the workspace to meter
 * @param {{ projects?: number|object, prompts?: number|object }} dims - per-dimension resources
 * @returns {Promise<void>}
 */
export async function setUmMockQuota(workspaceId, dims) {
  const res = await fetch(`${UM_MOCK_BASE}/__quota`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId, ...dims }),
  });
  if (!res.ok) {
    throw new Error(`UM mock __quota failed (${res.status}) for ${workspaceId}`);
  }
}

/**
 * Reads one vendor mock's full store snapshot from its `GET /__dump` control route. Each mock is
 * dumped on its own — unlike reset/readiness, which act on both at once (`MOCK_RESET_PATHS` /
 * `MOCK_DUMP_PATHS`), a test only ever inspects the mock it wrote through.
 *
 * @param {string} mockBase - the mock's API base URL
 * @param {string} label - short mock name, for the failure message
 * @returns {Promise<any>}
 */
async function dumpMock(mockBase, label) {
  const res = await fetch(`${mockBase}/__dump`);
  if (!res.ok) {
    throw new Error(`${label} mock __dump failed (${res.status})`);
  }
  return res.json();
}

/**
 * Reads the User Manager mock's full store snapshot — to assert mock-side state (e.g. a
 * workspace's resource `total` did/didn't change) after a request.
 *
 * Like `setUmMockQuota` above, this has no shared-test consumer today: the flag-ON block that read
 * it went with the allocator removal (SITES-49206). Kept and still threaded through `mockControls`
 * (serenity.test.js) as the UM-side counterpart of the consumed `dumpPeMock`, for the
 * spacecat-shared §10.5 metered-write assertions.
 * @returns {Promise<any>}
 */
export const dumpUmMock = () => dumpMock(UM_MOCK_BASE, 'UM');

/**
 * Reads the Project Engine mock's full store snapshot — the store as the vendor actually holds it,
 * keyed by collection (`prompts:{workspaceId}:{projectId}`, `tags:...`, ...).
 *
 * This is the ONLY way to assert what a write actually PERSISTED upstream, independently of what
 * the service's own read path chooses to ask for: the `by_tags` list gates `metadata` behind an
 * `include_metadata=true` query param, so a consumer that does not opt in reads back no metadata
 * at all even for a fully stamped prompt. Asserting authorship stamping through the list read
 * would therefore conflate "the write did not stamp" with "the read did not ask" — the dump
 * separates them.
 *
 * @returns {Promise<any>}
 */
export const dumpPeMock = () => dumpMock(PE_MOCK_BASE, 'PE');

/**
 * Replaces a benchmark on the Project Engine mock through the vendor's own update route, the way
 * Semrush's brand resolution would have — the mock has no control route for this, and none should
 * be added: the point is to leave the benchmark in a state only the vendor can produce.
 *
 * A benchmark carries alias values Semrush added itself (`gm` on General Motors, the misspelling
 * `pixlar` on pixlr). We hold no row for those, so nothing in our own derivation can reconstruct
 * one — which is exactly what makes them the test subject for a merge-over-live write. Seeding one
 * here and asserting it is still present after an unrelated brand edit is the only way to prove the
 * write merged rather than replaced.
 *
 * Full-replace semantics, mirroring the vendor: `brand_aliases` is the complete list, and `domain`
 * is required.
 *
 * @param {string} workspaceId - the sub-workspace holding the project
 * @param {string} projectId - the project holding the benchmark
 * @param {string} benchmarkId - the benchmark to replace
 * @param {{brand_name: string, domain: string, brand_aliases: string[]}} body - the new state
 * @returns {Promise<void>}
 */
export async function putPeBenchmark(workspaceId, projectId, benchmarkId, body) {
  const url = `${PE_MOCK_BASE}/v1/workspaces/${workspaceId}/projects/${projectId}/ai_models/benchmarks/${benchmarkId}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer it-seed' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`PE mock benchmark PUT failed (${res.status}) for ${benchmarkId}`);
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

  // The Semrush mocks serve self-signed HTTPS. Disable TLS verification for this
  // IT-only process now — the readiness probe below runs before buildEnv/startServer
  // would set the same flag, and it stays set for resetSemrushMocks() thereafter.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  execSync(
    `docker compose -f "${COMPOSE_FILE}" up -d`,
    // 240s, not 120s: a cold CI runner pulls five images here — Postgres, MinIO,
    // the data-service, and the two GHCR Semrush mocks — and the mock pulls alone
    // can blow a tight 2-minute budget on first run.
    { stdio: 'inherit', timeout: 240_000 },
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
