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

// @ts-check

import { hasText } from '@adobe/spacecat-shared-utils';
import { ErrorWithStatusCode } from '../utils.js';
import { SerenityTransportError } from './serenity-transport-error.js';

const QUERY_FANOUT_API_PATH = '/enterprise/data-builder/gateway/api/v1/query-fanouts';

// Semrush documents this as a job that can run for "up to a few hours"
// (see the serenity-query-fanouts Postman collection); a status GET itself
// is cheap, so a short timeout is appropriate here — this is NOT the budget
// for the run to finish, only for this one status check to answer.
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Validates and returns the canonical origin of SEMRUSH_PROJECTS_BASE_URL.
 * Mirrors `elements-transport.js`'s `baseUrl` — the Query Fan-out gateway
 * (`/enterprise/data-builder/gateway/...`) lives on the same Semrush origin
 * as the Elements (`/enterprise/pages/api/v3/...`) and Project Engine
 * (`/enterprise/projects/api`) gateways, just under a different path prefix.
 * @param {object} env
 * @returns {string}
 */
function baseUrl(env) {
  const raw = typeof env?.SEMRUSH_PROJECTS_BASE_URL === 'string'
    ? env.SEMRUSH_PROJECTS_BASE_URL.trim()
    : env?.SEMRUSH_PROJECTS_BASE_URL;
  if (!hasText(raw)) {
    throw new ErrorWithStatusCode(
      'SEMRUSH_PROJECTS_BASE_URL is not set. Configure it via Vault '
      + '(dx_mysticat/<env>/api-service) or .env for local dev.',
      503,
    );
  }
  const candidate = raw.replace(/\/$/, '');
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ErrorWithStatusCode(
      `SEMRUSH_PROJECTS_BASE_URL is not a valid URL: ${candidate}`,
      503,
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new ErrorWithStatusCode(
      `SEMRUSH_PROJECTS_BASE_URL must use https (got ${parsed.protocol})`,
      503,
    );
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function buildHeaders(imsToken) {
  if (!hasText(imsToken)) {
    throw new SerenityTransportError(401, 'Missing IMS bearer token for Query Fan-out transport');
  }
  return {
    Authorization: `Bearer ${imsToken}`,
    Accept: 'application/json',
  };
}

async function parseBody(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function enc(segment) {
  return encodeURIComponent(String(segment ?? ''));
}

/**
 * Creates the Semrush Query Fan-out HTTP transport.
 *
 * Deliberately READ-ONLY today: this module does not expose a "create run"
 * call. Query fan-out runs are started manually (see the
 * `serenity-query-fanouts` Postman collection's "Create run" request) while
 * the create-and-poll workflow is designed; this transport only checks the
 * status of a run that already exists, by `(workspaceId, runId)`. See
 * `docs/plans/2026-08-18-serenity-query-fanout-status.md` for the phased plan
 * (creating runs + async polling is Phase 2).
 *
 * @param {object} args
 * @param {object} args.env - Environment (reads SEMRUSH_PROJECTS_BASE_URL).
 * @param {string} args.imsToken - IMS user bearer token (without 'Bearer ' prefix) —
 *   resolved by the caller via `resolveSemrushImsToken` (utils.js), which accepts
 *   either a caller-supplied `x-promise-token` (preferred) or a raw IMS bearer.
 * @param {number} [args.timeoutMs] - Per-call timeout (default 15s).
 */
export function createQueryFanoutTransport({ env, imsToken, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const root = baseUrl(env);

  return {
    /**
     * GET /enterprise/data-builder/gateway/api/v1/query-fanouts/{runId}?workspace_id={workspaceId}
     *
     * A single attempt, no retry: this is a plain status poll invoked
     * synchronously from a request handler, not a background job — a
     * transient failure should surface to the caller immediately rather than
     * hold the request open for a retry/backoff loop.
     *
     * @param {object} args
     * @param {string} args.workspaceId
     * @param {string} args.runId
     * @returns {Promise<{id: string, status: 'queued'|'running'|'succeeded'|'failed'}>}
     * @throws {SerenityTransportError} on a non-2xx upstream response (404 = run
     *   not found in this workspace, per the Postman collection's notes).
     */
    async getRunStatus({ workspaceId, runId }) {
      const url = `${root}${QUERY_FANOUT_API_PATH}/${enc(runId)}?workspace_id=${enc(workspaceId)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: buildHeaders(imsToken),
          signal: controller.signal,
        });
      } catch (e) {
        if (e?.name === 'AbortError') {
          throw new SerenityTransportError(504, `Query Fan-out status GET ${url} timed out after ${timeoutMs}ms`);
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }

      const parsed = await parseBody(response);
      if (!response.ok) {
        throw new SerenityTransportError(
          response.status,
          `Query Fan-out status GET ${url} failed: ${response.status}`,
          parsed,
        );
      }
      return parsed;
    },
  };
}
